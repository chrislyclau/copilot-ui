import {
  AssistantMessageEvent,
  CopilotClient,
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  Tool,
} from './boundary';
import { FROZEN_SDK_SYSTEM_MESSAGE_BASELINE } from './systemMessageBaseline';

/** Config fields callers must NOT supply themselves -- always derived by `_createConfig()`. */
type ConfigOwnedKeys =
  | 'availableTools'
  | 'tools'
  | 'systemMessage'
  | 'autoApproveAll'
  | 'onPermissionRequest'
  | 'model';

/**
 * Whatever the caller still needs to provide to create/resume a session
 * (`workingDirectory`, etc) -- anything `_createConfig()` derives, including
 * `model` (owned state per SYS-REQ-027, set via `setModelName`), is excluded
 * at the type level so it can never be supplied out of band (mirrors
 * `HardenedSessionBaseConfig`).
 */
export type SessionWrapperBaseConfig = Omit<SessionConfig, ConfigOwnedKeys>;

/**
 * Maps a built-in tool's wire name (as passed to `addTools`) to the
 * permission-request `kind` the SDK reports for it (see
 * `extractRequestedToolName` below). Only `PermissionRequest` variants
 * `mcp`/`custom-tool`/`hook` carry a `toolName` field; built-ins are
 * identified by `kind` alone, so a wire name absent from this map is
 * assumed to already resolve via `toolName` (custom/MCP/hook tools) and is
 * checked unchanged.
 *
 * FOOTGUN (verified against the live SDK, see
 * sessionWrapper.integration.test.ts "kind collision" test): `view` and
 * `grep` collide on kind `'read'`. If a bare `kind: 'read'` PermissionRequest
 * ever reached `_createConfig()`'s handler while only one of the two was
 * added, `allowedKinds` (derived purely from kind, not tool identity) could
 * not tell them apart and would wrongly approve the other. This is currently
 * NOT exploitable in practice: the SDK's own `availableTools` filter is
 * name-based and rejects an unlisted tool (e.g. `grep` when only `view` was
 * added) before any kind-based reasoning in this handler is reached -- the
 * integration test locks this in. But that safety is incidental to this
 * file's own logic, not guaranteed by it: if the SDK's `availableTools`
 * gating ever changes, or a future built-in tool is added to this map
 * sharing a kind with one already in use, this handler alone would not
 * catch the collision. Do not treat `onPermissionRequest`'s kind-based
 * check as a name-level enforcement boundary.
 */
const BUILTIN_TOOL_PERMISSION_KIND: Readonly<Record<string, string>> = {
  bash: 'shell',
  view: 'read',
  edit: 'write',
  grep: 'read',
  glob: 'read',
};

/**
 * Resolves the name to check a `PermissionRequest` against `_tools`
 * membership (SYS-REQ-027h). Built-in variants (`shell`, `write`, `read`,
 * `url`, `memory`, `extension-management`, `extension-permission-access`)
 * have no `toolName` field -- for those, `kind` itself already identifies
 * the tool.
 */
function extractRequestedToolName(req: PermissionRequest): string {
  switch (req.kind) {
    case 'mcp':
    case 'custom-tool':
    case 'hook':
      return req.toolName;
    case 'shell':
    case 'write':
    case 'read':
    case 'url':
    case 'memory':
    case 'extension-management':
    case 'extension-permission-access':
      return req.kind;
    default: {
      // Exhaustiveness guard: an SDK-added variant falls back to its `kind`
      // rather than being silently mishandled.
      const unknownReq = req as { kind: string };
      return unknownReq.kind;
    }
  }
}

/**
 * A short, deterministic description of the current tool list, appended to
 * the system message so it can never disagree with `availableTools` /
 * permission outcomes -- all three are derived from the same `tools` array
 * in the same call (SYS-REQ-027b/h).
 */
function buildToolUsageSection(tools: readonly string[]): string {
  if (tools.length === 0) {
    return 'No tools are available in this session. Do not attempt to call any tool.';
  }
  return (
    `# Tools available this session\n` +
    `Only the following tools may be called: ${tools.join(', ')}. ` +
    `Any other tool call will be rejected.`
  );
}

/**
 * Builds the entire outgoing `systemMessage` in the SDK's `replace` mode,
 * unconditionally (issue #345 follow-up). `append`/`customize` modes still
 * splice an SDK-managed `tool_instructions` section into the prompt that's
 * re-derived from the live `availableTools` on every single turn -- that
 * per-turn regeneration is exactly the KV-cache-prefix hazard #345 exists to
 * close, and no combination of our own content in those modes can stop the
 * SDK from doing it. `replace` mode is the only one that hands us the whole
 * prompt with nothing left for the SDK to inject.
 *
 * That means WE now own reproducing the SDK's own baseline guidance
 * (`FROZEN_SDK_SYSTEM_MESSAGE_BASELINE`, a hand-captured, hand-maintained
 * copy -- see systemMessageBaseline.ts for what's deliberately excluded from
 * it and why) rather than getting it "for free" from `append`/`customize`
 * mode. The tradeoff, called out directly in the SDK's own docs: replace
 * mode also drops the SDK's built-in guardrail/security sections, which
 * `FROZEN_SDK_SYSTEM_MESSAGE_BASELINE` does still carry forward as of the
 * capture date, but it will silently stop tracking any *future* guardrail
 * the SDK adds until this file's baseline is re-captured.
 */
function buildFrozenReplaceSystemMessage(
  toolUsageSection: string,
  callerContent: string | undefined
): SessionConfig['systemMessage'] {
  const parts = [FROZEN_SDK_SYSTEM_MESSAGE_BASELINE, toolUsageSection];
  if (callerContent) {
    parts.push(callerContent);
  }
  return { mode: 'replace', content: parts.join('\n\n') };
}

/**
 * Builds a plain-text notice describing what changed in tool list / system
 * prompt since the last turn, or `undefined` if nothing changed. Appended to
 * the outgoing prompt on resume (SYS-REQ-027k) instead of folding the change
 * into `systemMessage`, which -- per the KV-cache prefix hazard documented on
 * issue #345 -- must stay byte-identical across every `resumeSession` call
 * for a given session. A message appended to the *end* of the conversation
 * only ever grows the prompt; it never rewrites tokens the cache already has,
 * so it cannot itself cause a prefix mismatch the way editing `systemMessage`
 * does.
 */
function buildSessionUpdateNotice(
  previousTools: readonly string[],
  nextTools: readonly string[],
  previousSystemPrompt: string | undefined,
  nextSystemPrompt: string | undefined
): string | undefined {
  const previousSet = new Set(previousTools);
  const nextSet = new Set(nextTools);
  const added = nextTools.filter((name) => !previousSet.has(name));
  const removed = previousTools.filter((name) => !nextSet.has(name));
  const systemPromptChanged = previousSystemPrompt !== nextSystemPrompt;

  if (added.length === 0 && removed.length === 0 && !systemPromptChanged) {
    return undefined;
  }

  const lines: string[] = [
    '# Session update',
    "This session's configuration changed since the last turn. The system " +
      'prompt shown above is not being regenerated (it must stay fixed for ' +
      'prompt-cache reasons), so this note is how any change reaches you.',
  ];
  if (added.length > 0) {
    lines.push(`Tools added: ${added.join(', ')}.`);
  }
  if (removed.length > 0) {
    lines.push(
      `Tools removed: ${removed.join(', ')}. Do not call these; calls to them will be rejected.`
    );
  }
  lines.push(`Tools currently available: ${nextTools.length > 0 ? nextTools.join(', ') : '(none)'}.`);
  if (systemPromptChanged) {
    lines.push('Additional operating instructions have also been updated for this turn.');
  }
  return lines.join('\n');
}

/**
 * `SessionWrapper` — replaces `hardenedSession.ts` (see README.md
 * "SessionWrapper — Spec Draft (EARS)", SYS-REQ-027 family). Built in
 * isolation per the spec's hotswap migration strategy: this file has zero
 * imports from or into `hardenedSession.ts`, and nothing in production
 * wires to it yet.
 *
 * Private state, builder-style mutators (SYS-REQ-027, 027a, 027a-1), config
 * derivation (`_createConfig()`, SYS-REQ-027b/h/i/j), and the create/resume
 * lifecycle (`sendAndWait()`, SYS-REQ-027c/d) all live here. Post-start
 * mutator behavior (SYS-REQ-027f) is resolved, not open: mutators are plain
 * field updates (SYS-REQ-027j) with no started-state check, so a mutator
 * called after a session has started is never rejected -- it's applied and
 * takes effect starting the next `_createConfig()` derivation (i.e. the
 * next `sendAndWait()` call), never mid-turn. See each mutator below.
 */
export class SessionWrapper {
  /**
   * SDK-level tool allowlist (`availableTools`/permission membership, per
   * SYS-REQ-027h). All tools -- including built-ins like `bash`, `view`,
   * `edit`, `grep`, `glob`, and the docker-terminal tool -- must be added
   * explicitly via `addTools`; none is enabled by default (SYS-REQ-027a-1).
   *
   * The SDK's `PermissionRequest` union has no variant representing an
   * internal completion/abort signal distinct from a genuine tool call
   * (verified against `@github/copilot-sdk`'s type definitions) -- so no
   * tool name is exempt from this membership requirement.
   */
  private _tools: Set<string> = new Set();

  /**
   * Handler-backed tools this instance owns (SYS-REQ-027a, this issue).
   * Stored separately from `_tools` (wire names only, `Set<string>`)
   * because a `Tool` carries a handler and other SDK-dispatch fields that
   * `_tools` has no room for. Keyed by name so `addTool`/`removeTool`
   * mirror `addTools`/`removeTools`'s builder shape -- add is idempotent
   * per name, remove is a no-op if the name isn't present.
   */
  private _customTools: Map<string, Tool> = new Map();

  /**
   * Caller-supplied additional instructions, plain text only. Unlike before
   * #345's `replace`-mode switch, there is no `mode`/`sections` concept left
   * to expose here: `_createConfig()` always forces `systemMessage` into the
   * SDK's `replace` mode (see `buildFrozenReplaceSystemMessage`), so an
   * `append`/`customize` mode or a `sections` override from the caller would
   * never reach the SDK -- exposing them here would silently do nothing,
   * which is worse than not offering them.
   */
  private _systemPrompt: string | undefined = undefined;

  private _modelName: string | undefined = undefined;

  /**
   * The live SDK session backing this wrapper, once `sendAndWait()` has been
   * called at least once. `undefined` here (rather than a stored
   * `sessionId`) is precisely what tells `sendAndWait()` to create instead
   * of resume (SYS-REQ-027c).
   */
  private _session: CopilotSession | undefined = undefined;

  /**
   * The `systemMessage` passed on session *creation* (SYS-REQ-027k). Frozen
   * the moment `createSession` is called and reused byte-for-byte on every
   * subsequent `resumeSession` for this session's lifetime, regardless of
   * later `addTool`/`removeTool`/`setSystemPrompt` calls -- the SDK includes
   * `systemMessage` in the cached prompt prefix, so re-deriving it per turn
   * (the pre-#345 behavior) busts that prefix's KV cache on every resume.
   * `undefined` until the first `sendAndWait()` creates a session.
   */
  private _frozenSystemMessage: SessionConfig['systemMessage'] | undefined = undefined;

  /**
   * Snapshot of `_tools`/`_systemPrompt` as of the last turn actually sent
   * to the SDK (create or resume) -- NOT the same as "as of the last
   * mutator call". Diffed against current state in `sendAndWait()` to decide
   * what belongs in the update notice appended to this turn's prompt
   * (SYS-REQ-027k). Tool identity only; `_customTools`' handlers don't
   * factor into the diff.
   */
  private _announcedTools: readonly string[] = [];
  private _announcedSystemPrompt: string | undefined = undefined;

  /**
   * `_client` is optional at construction so existing `_createConfig()`-only
   * tests/call sites (which never call `sendAndWait`) don't need to supply
   * one; `sendAndWait()` throws immediately if it's missing (SYS-REQ-027f
   * spirit: an explicitly-defined failure rather than a null-deref deep
   * inside the SDK call).
   */
  constructor(
    private readonly _client?: CopilotClient,
    private readonly _baseConfig: SessionWrapperBaseConfig = {}
  ) {}

  /**
   * Adds one or more tools to the session's tool list. Builder-style: only
   * ever grows `_tools`, never replaces it wholesale (SYS-REQ-027a). If
   * called after a session has started, never rejected -- takes effect
   * starting the next `_createConfig()` derivation, not the in-flight turn
   * (SYS-REQ-027f, resolved by SYS-REQ-027j).
   */
  addTools(...names: readonly string[]): this {
    for (const name of names) {
      this._tools.add(name);
    }
    return this;
  }

  /**
   * Removes one or more tools from the session's tool list. The
   * counterpart builder-style mutator to `addTools` (SYS-REQ-027a). If
   * called after a session has started, never rejected -- takes effect
   * starting the next `_createConfig()` derivation, not the in-flight turn
   * (SYS-REQ-027f, resolved by SYS-REQ-027j).
   *
   * Also clears any matching entry from `_customTools` (SYS-REQ-027h): a
   * name removed here may have been added via `addTool` rather than
   * `addTools`, and `_createConfig()` derives `availableTools` from `_tools`
   * but `tools` (the handler-dispatch array) from `_customTools` -- leaving
   * a stale `_customTools` entry after `_tools` no longer has the name would
   * let those two derived outputs disagree (a handler-backed tool present
   * in `tools` but absent from `availableTools`/the permission allowlist),
   * violating the single-derivation-point invariant `_createConfig()`
   * exists to guarantee. `removeTool` remains the more explicit way to
   * remove a custom tool, but `removeTools` must not leave this door open
   * just because the caller used the built-in-shaped method instead.
   */
  removeTools(...names: readonly string[]): this {
    for (const name of names) {
      this._tools.delete(name);
      this._customTools.delete(name);
    }
    return this;
  }

  /**
   * Attaches a handler-backed custom `Tool` this session owns from
   * creation (this issue; not the #327 `registerSessionPolicy` side door --
   * this takes a `Tool` this instance is given directly, never a
   * `sessionId` or externally-created session). Builder-style, mirroring
   * `addTools`: adds `tool.name` to the SDK-level allowlist (`_tools`,
   * SYS-REQ-027h membership) and stores the handler-backed `Tool` itself so
   * `_createConfig()` can include it in the derived `tools` array. If
   * called after a session has started, never rejected -- takes effect
   * starting the next `_createConfig()` derivation, not the in-flight turn
   * (SYS-REQ-027f, resolved by SYS-REQ-027j).
   */
  addTool(tool: Tool): this {
    this._tools.add(tool.name);
    this._customTools.set(tool.name, tool);
    return this;
  }

  /**
   * Removes a handler-backed custom tool previously added via `addTool`.
   * The counterpart builder-style mutator to `addTool`, mirroring
   * `removeTools`. A no-op if `name` was never added. If called after a
   * session has started, never rejected -- takes effect starting the next
   * `_createConfig()` derivation, not the in-flight turn (SYS-REQ-027f,
   * resolved by SYS-REQ-027j).
   */
  removeTool(name: string): this {
    this._tools.delete(name);
    this._customTools.delete(name);
    return this;
  }

  /**
   * Sets the caller's additional operating instructions (SYS-REQ-027a),
   * appended after the SDK baseline and tool-usage section that
   * `_createConfig()` always builds first. Plain text only -- as of #345's
   * `replace`-mode switch there's no `mode`/`sections` for a caller to pick,
   * since `_createConfig()` always forces the SDK's `replace` mode itself
   * (see `buildFrozenReplaceSystemMessage`); an `append`/`customize`
   * distinction here would imply a choice that no longer does anything. If
   * called after a session has started, never rejected -- takes effect
   * starting the next `_createConfig()` derivation, not the in-flight turn
   * (SYS-REQ-027f, resolved by SYS-REQ-027j).
   */
  setSystemPrompt(content: string | undefined): this {
    this._systemPrompt = content;
    return this;
  }

  /**
   * Replaces the session's model name (SYS-REQ-027a). If called after a
   * session has started, never rejected -- takes effect starting the next
   * `_createConfig()` derivation, not the in-flight turn (SYS-REQ-027f,
   * resolved by SYS-REQ-027j).
   */
  setModelName(modelName: string): this {
    this._modelName = modelName;
    return this;
  }

  /**
   * The single, non-split derivation point (SYS-REQ-027b) that turns this
   * instance's private state into the SDK-bound config: `availableTools`,
   * the tool-usage section of `systemMessage`, and tool-call permission are
   * all computed here from the same `_tools` snapshot, so they cannot
   * independently drift from one another (SYS-REQ-027h).
   *
   * Called fresh at the start of every turn (by `sendAndWait`, below) for
   * `availableTools`/`tools`/permission handling, so a tool removed via
   * `removeTools` is denied starting next turn without needing any other
   * bookkeeping (SYS-REQ-027j).
   *
   * `systemMessage` is the one exception: once a session exists,
   * `_frozenSystemMessage` (set by `sendAndWait` on creation) is returned
   * as-is rather than re-derived. Without this, a caller inspecting
   * `_createConfig()`'s output after the session has started -- tests, or
   * anything reading the config for logging/assertions -- would see a
   * freshly-recomputed `systemMessage` reflecting current tools/prompt,
   * while `sendAndWait` actually sends the *frozen* one on resume
   * (SYS-REQ-027k). That mismatch is exactly the footgun this guards
   * against: `_createConfig()`'s return value must always match what's
   * really in flight, never a preview of what a fresh derivation would be.
   */
  _createConfig(): Pick<SessionConfig, 'availableTools' | 'tools' | 'systemMessage' | 'model'> & {
    autoApproveAll: false;
    onPermissionRequest: (
      req: PermissionRequest,
      invocation: { sessionId: string }
    ) => Promise<PermissionRequestResult>;
  } {
    // Snapshot once per call: every derived output below (availableTools,
    // the system-prompt tool section, and the permission handler's closed-
    // over allowlist) reads this same array, not `this._tools` again later.
    const tools = [...this._tools];
    const allowedKinds = new Set(tools.map((name) => BUILTIN_TOOL_PERMISSION_KIND[name] ?? name));

    return {
      availableTools: tools as SessionConfig['availableTools'],
      // Handler-backed tools added via `addTool` -- `_tools` (above) holds
      // the wire-name allowlist for all tools including these, while
      // `_customTools` holds the actual `Tool` objects (with handlers) so
      // the SDK can dispatch calls to them. Re-read fresh every call, same
      // as `_tools` itself (SYS-REQ-027j).
      tools: [...this._customTools.values()] as SessionConfig['tools'],
      // Frozen once a session exists (see the doc comment above) -- only
      // ever recomputed for the pre-creation call whose result becomes that
      // frozen value in the first place.
      systemMessage:
        this._frozenSystemMessage ??
        buildFrozenReplaceSystemMessage(buildToolUsageSection(tools), this._systemPrompt),
      model: this._modelName,
      autoApproveAll: false,
      onPermissionRequest: async (
        req: PermissionRequest,
        _invocation: { sessionId: string }
      ): Promise<PermissionRequestResult> => {
        // Independently evaluated per call (SYS-REQ-027i): no cross-call
        // caching, no session-wide standing grant.
        const requestedTool = extractRequestedToolName(req);
        if (allowedKinds.has(requestedTool)) {
          return { kind: 'approve-once' };
        }
        return {
          kind: 'reject',
          feedback: `Tool '${requestedTool}' is not permitted under this session's policy.`,
        };
      },
    };
  }

  /**
   * Owns the full session lifecycle (SYS-REQ-027c): derives a fresh config
   * via `_createConfig()`, then decides internally whether to create a new
   * SDK session or resume the one this instance already owns -- a decision
   * invisible to the caller, who always gets back the same
   * `AssistantMessageEvent | undefined` shape `CopilotSession.sendAndWait`
   * itself returns.
   *
   * Re-derives config from current instance state on every call, including
   * resumes (SYS-REQ-027d): nothing here is cached from a prior
   * `sendAndWait()` call, so mutating tools/system prompt/model between
   * calls and then resuming reflects the new state, not stale config
   * (carries forward SYS-REQ-026b's intent -- see issue #208's
   * systemMessage-drop-on-resume hazard in boundary.ts/AGENTS.md, which
   * this sidesteps by always re-passing systemMessage explicitly).
   *
   * Requires `setModelName` to have been called first. `model` is owned
   * state (see `ConfigOwnedKeys`), so there's no `_baseConfig` fallback to
   * silently merge in its place -- an unset model fails loudly here rather
   * than spreading `model: undefined` over any value the caller thinks
   * they've configured (SYS-REQ-027's "state lives on the instance" is only
   * meaningful if a missing piece of it is an error, not a silent default).
   */
  async sendAndWait(prompt: string | MessageOptions, timeout?: number): Promise<AssistantMessageEvent | undefined> {
    if (!this._client) {
      throw new Error('SessionWrapper.sendAndWait: no CopilotClient was supplied to this instance.');
    }
    if (!this._modelName) {
      throw new Error('SessionWrapper.sendAndWait: no model name was set. Call setModelName() first.');
    }
    const config = this._createConfig();
    let effectivePrompt = prompt;

    if (!this._session) {
      // Creating: `config.systemMessage` becomes the permanent prefix for
      // this session's life (SYS-REQ-027k) -- freeze it now, before it's
      // ever sent, so every later resume reuses this exact value.
      this._frozenSystemMessage = config.systemMessage;
      this._session = await this._client.createSession({ ...this._baseConfig, ...config });
    } else {
      // Resuming: reuse the frozen systemMessage rather than `config`'s
      // freshly-derived one, so this call's prefix is byte-identical to the
      // create call's (SYS-REQ-027k / issue #345). Any drift in tools or
      // system prompt since the last turn is relayed via a notice appended
      // to the prompt below instead -- that only grows the conversation, so
      // it can't itself invalidate the cached prefix the way editing
      // `systemMessage` would.
      const notice = buildSessionUpdateNotice(
        this._announcedTools,
        [...this._tools],
        this._announcedSystemPrompt,
        this._systemPrompt
      );
      const resumeConfig = { ...config, systemMessage: this._frozenSystemMessage };
      this._session = await this._client.resumeSession(this._session.sessionId, {
        ...this._baseConfig,
        ...resumeConfig,
      });
      if (notice) {
        effectivePrompt =
          typeof prompt === 'string'
            ? `${notice}\n\n${prompt}`
            : { ...prompt, prompt: `${notice}\n\n${prompt.prompt}` };
      }
    }

    this._announcedTools = [...this._tools];
    this._announcedSystemPrompt = this._systemPrompt;

    // TS can't resolve `session.sendAndWait`'s overloads against a `string |
    // MessageOptions` union directly (call site, not signature, must narrow) --
    // this branch exists only for that; both arms call the same thing.
    return typeof effectivePrompt === 'string'
      ? this._session.sendAndWait(effectivePrompt, timeout)
      : this._session.sendAndWait(effectivePrompt, timeout);
  }
}
