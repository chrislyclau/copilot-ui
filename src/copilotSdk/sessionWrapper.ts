import {
  AssistantMessageEvent,
  CopilotClient,
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
} from './boundary';

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
 * Folds `toolUsageSection` into `systemPrompt` according to its mode, so the
 * tool-usage guidance is present regardless of whether the caller supplied a
 * system prompt at all, or which mode they chose:
 * - undefined / `append`: tool section + caller content, both appended after
 *   the SDK-managed prompt.
 * - `replace`: tool section is folded into `content`, since replace mode
 *   removes the SDK-managed prompt entirely and nothing else would supply it.
 * - `customize`: tool section goes in the mode's own `content` field
 *   (appended after all sections) rather than a per-tool section override --
 *   per-tool section regeneration on `resumeSession` retries invalidates the
 *   prompt/KV cache (issue #146).
 */
function mergeToolUsageIntoSystemMessage(
  toolUsageSection: string,
  systemPrompt: SessionConfig['systemMessage']
): SessionConfig['systemMessage'] {
  if (!systemPrompt || systemPrompt.mode === undefined || systemPrompt.mode === 'append') {
    const content = systemPrompt?.content;
    return {
      mode: 'append',
      content: content ? `${toolUsageSection}\n\n${content}` : toolUsageSection,
    };
  }
  if (systemPrompt.mode === 'replace') {
    return {
      mode: 'replace',
      content: `${toolUsageSection}\n\n${systemPrompt.content}`,
    };
  }
  // mode === 'customize'
  return {
    ...systemPrompt,
    content: systemPrompt.content ? `${toolUsageSection}\n\n${systemPrompt.content}` : toolUsageSection,
  };
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

  private _systemPrompt: SessionConfig['systemMessage'] | undefined = undefined;

  private _modelName: string | undefined = undefined;

  /**
   * The live SDK session backing this wrapper, once `sendAndWait()` has been
   * called at least once. `undefined` here (rather than a stored
   * `sessionId`) is precisely what tells `sendAndWait()` to create instead
   * of resume (SYS-REQ-027c).
   */
  private _session: CopilotSession | undefined = undefined;

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
   */
  removeTools(...names: readonly string[]): this {
    for (const name of names) {
      this._tools.delete(name);
    }
    return this;
  }

  /**
   * Replaces the session's system prompt (SYS-REQ-027a). If called after a
   * session has started, never rejected -- takes effect starting the next
   * `_createConfig()` derivation, not the in-flight turn (SYS-REQ-027f,
   * resolved by SYS-REQ-027j).
   */
  setSystemPrompt(systemPrompt: SessionConfig['systemMessage']): this {
    this._systemPrompt = systemPrompt;
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
   * Called fresh at the start of every turn (by `sendAndWait`, below) --
   * never cached -- so a tool removed via `removeTools` is denied starting
   * next turn without needing any other bookkeeping (SYS-REQ-027j).
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
      // No custom tool handlers are registered on this instance today --
      // `_tools` holds wire names only (SYS-REQ-027a-1's built-ins). Extend
      // this once SessionWrapper grows a way to attach a handler per name.
      tools: [] as SessionConfig['tools'],
      systemMessage: mergeToolUsageIntoSystemMessage(buildToolUsageSection(tools), this._systemPrompt),
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

    this._session = this._session
      ? await this._client.resumeSession(this._session.sessionId, { ...this._baseConfig, ...config })
      : await this._client.createSession({ ...this._baseConfig, ...config });

    // TS can't resolve `session.sendAndWait`'s overloads against a `string |
    // MessageOptions` union directly (call site, not signature, must narrow) --
    // this branch exists only for that; both arms call the same thing.
    return typeof prompt === 'string'
      ? this._session.sendAndWait(prompt, timeout)
      : this._session.sendAndWait(prompt, timeout);
  }
}
