import {
  AssistantMessageEvent,
  CopilotClient,
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEventHandler,
  SessionEventType,
  Tool,
  TypedSessionEventHandler,
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
 * `model` (owned state, set via `setModelName`), is excluded at the type
 * level so it can never be supplied out of band.
 */
export type SessionWrapperBaseConfig = Omit<SessionConfig, ConfigOwnedKeys>;

/**
 * One entry of `sendAndWait`'s `listeners` array: either a type-filtered
 * entry (`{ type, handler }`, mirrors `CopilotSession.on(type, handler)`,
 * with `handler` narrowed to that specific event's payload) or an
 * all-events entry (`{ handler }`, mirrors `CopilotSession.on(handler)`).
 * Declared as a distributed mapped type over `SessionEventType` rather than
 * `{ type: SessionEventType; handler: TypedSessionEventHandler<SessionEventType> }`
 * directly -- the latter doesn't distribute (`T` in
 * `TypedSessionEventHandler<T>` is instantiated once with the whole union),
 * so a caller's `{ type: 'tool.execution_start', handler: aNarrowlyTypedHandler }`
 * would fail to typecheck against it even though it's exactly the intended usage.
 */
export type SessionListenerEntry =
  | { [K in SessionEventType]: { type: K; handler: TypedSessionEventHandler<K> } }[SessionEventType]
  | { handler: SessionEventHandler };

/**
 * The full, fixed tool set for a session's lifetime (SYS-REQ-028/028a). This
 * is the ONLY place a tool schema can be declared -- there is no
 * post-construction method that adds a tool absent here. `builtins` are
 * SDK-native wire names (e.g. `bash`, `view`); omitting a built-in here
 * excludes it for the session's lifetime (SYS-REQ-028a-1) -- there is no
 * separate runtime exclusion mechanism. `custom` are handler-backed `Tool`
 * objects this instance dispatches itself.
 */
export interface SessionWrapperToolsConfig {
  readonly builtins?: readonly string[];
  readonly custom?: readonly Tool[];
}

/**
 * Maps a built-in tool's wire name to the permission-request `kind` the SDK
 * reports for it (see `extractRequestedToolName` below). Only `PermissionRequest`
 * variants `mcp`/`custom-tool`/`hook` carry a `toolName` field; built-ins are
 * identified by `kind` alone, so a wire name absent from this map is assumed
 * to already resolve via `toolName` (custom/MCP/hook tools) and is checked
 * unchanged.
 *
 * COLLISION (verified against the live SDK's `PermissionRequestRead` shape,
 * which carries `path`/`intention`/`toolCallId` but no tool name): `view`,
 * `grep`, and `glob` all map to kind `'read'`. Before SYS-REQ-028d-1, this
 * was masked by the SDK's own name-based `availableTools` gate, which
 * rejected a disabled sibling by name before this handler ever ran. Now that
 * `availableTools` is always the full construction-time list, a same-kind
 * request CAN reach `_onPermissionRequest` while only some kind-siblings are
 * enabled, and there is no field in the request to tell which specific
 * sibling issued it. `_onPermissionRequest` handles this by requiring EVERY
 * built-in sharing a requested kind to be enabled before approving --
 * disabling any one of `view`/`grep`/`glob` causes calls resolved to `'read'`
 * to be rejected until it's re-enabled, even for calls that were "really"
 * meant for a still-enabled sibling. This is deliberately conservative:
 * SYS-REQ-028d requires a disabled tool's calls to be rejected, and
 * over-rejecting an ambiguous shared-kind call is the only safe direction
 * when the alternative is silently approving one that could be a disabled
 * tool in disguise.
 */
const BUILTIN_TOOL_PERMISSION_KIND: Readonly<Record<string, string>> = {
  bash: 'shell',
  view: 'read',
  edit: 'write',
  grep: 'read',
  glob: 'read',
};

/**
 * Resolves the name to check a `PermissionRequest` against the enabled-tool
 * subset (SYS-REQ-028d). Built-in variants (`shell`, `write`, `read`, `url`,
 * `memory`, `extension-management`, `extension-permission-access`) have no
 * `toolName` field -- for those, `kind` itself already identifies the tool.
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
 * Plain-text notice stating the currently-enabled tool subset, injected on
 * EVERY turn including the first (SYS-REQ-028i) and prepended to the
 * outgoing user turn's prompt, never folded into `systemMessage`
 * (SYS-REQ-028l): `systemMessage` must stay byte-identical across every
 * resume (SYS-REQ-028g/h), so text that changes turn-to-turn cannot live
 * there without either going stale or busting the cached prefix. This is the
 * sole authoritative, model-facing signal of what's actually callable --
 * schema presence in `tools`/`availableTools` is constant regardless of
 * enablement (SYS-REQ-028/028d-1) and the SDK's own auto-generated tool
 * descriptions may describe a disabled built-in as generically available
 * (SYS-REQ-028d-2, expected and not a defect).
 */
function buildEnablementNotice(enabledTools: readonly string[]): string {
  if (enabledTools.length === 0) {
    return (
      '# Tools enabled this turn\n' +
      'No tools are currently enabled. Any tool call will be rejected, even to a tool whose schema you can see.'
    );
  }
  return (
    '# Tools enabled this turn\n' +
    `Only the following tools are currently enabled and may be called: ${enabledTools.join(', ')}. ` +
    'A call to any other tool -- including one whose schema is visible to you -- will be rejected.'
  );
}

/**
 * Builds the `systemMessage` config sent once at session creation
 * (SYS-REQ-028h): always `customize` mode, carrying only the caller's own
 * instructions. Unlike the pre-028 `replace`-mode implementation, there is
 * no hand-authored frozen baseline reproduced here -- `customize` mode lets
 * the SDK inject its own baseline/tool-instructions sections, which is safe
 * now that `availableTools` is itself fixed at construction and never
 * narrowed (SYS-REQ-028d-1), so the SDK-managed sections it derives from
 * `availableTools` cannot drift the cached prefix across resume the way
 * they could before this spec.
 */
function buildCustomizeSystemMessage(callerContent: string | undefined): SessionConfig['systemMessage'] {
  return { mode: 'customize', content: callerContent ?? '' };
}

/**
 * Builds a plain-text notice describing what changed in the caller's
 * additional system-prompt instructions since the last turn, or `undefined`
 * if nothing changed. Tool enablement changes are already relayed every turn
 * via `buildEnablementNotice` and are NOT repeated here. Appended alongside
 * that notice to the outgoing prompt on resume rather than folded into
 * `systemMessage`, for the same reason: `systemMessage` must stay
 * byte-identical across every `resumeSession` call for a given session
 * (SYS-REQ-028g/h). A message appended to the *end* of the conversation only
 * ever grows the prompt; it never rewrites tokens the cache already has, so
 * it cannot itself cause a prefix mismatch the way editing `systemMessage`
 * does.
 */
function buildSystemPromptUpdateNotice(
  previousSystemPrompt: string | undefined,
  nextSystemPrompt: string | undefined
): string | undefined {
  if (previousSystemPrompt === nextSystemPrompt) {
    return undefined;
  }
  return (
    '# Session update\n' +
    "This session's additional operating instructions changed since the last turn. " +
    'The system prompt shown above is not being regenerated (it must stay fixed for ' +
    'prompt-cache reasons), so this note is how the change reaches you.'
  );
}

/**
 * `SessionWrapper` -- implements docs/SessionWrapper-spec.md's SYS-REQ-028
 * family (issue #352), which supersedes the tool-mutation and
 * system-message parts of the earlier SYS-REQ-027 family. The core shift:
 * the wire-level `tools` schema sent to the SDK is now fixed at construction
 * and NEVER changes for the session's lifetime (SYS-REQ-028), including
 * across every resume -- tool "enablement" is a purely private, mutable
 * subset enforced only at the permission layer (SYS-REQ-028c/d), never by
 * changing what's declared to the model.
 */
export class SessionWrapper {
  /**
   * Construction-time, wire-name-ordered list of every tool this session
   * will ever declare (built-ins + custom), fixed for the session's
   * lifetime (SYS-REQ-028/028a). Never mutated after the constructor runs.
   */
  private readonly _allToolNames: readonly string[];

  /** `_allToolNames` as a `Set`, for O(1) construction-time-membership checks. */
  private readonly _allToolNamesSet: ReadonlySet<string>;

  /**
   * Reverse index from a shared `BUILTIN_TOOL_PERMISSION_KIND` value to every
   * construction-time built-in name that maps to it (e.g. `'read'` ->
   * `['view', 'grep', 'glob']`, restricted to whichever of those this
   * instance actually declared). Built once at construction, since
   * `_allToolNames` never changes afterward. Used by `_onPermissionRequest`
   * to detect when a `kind`-derived request is ambiguous between multiple
   * declared built-ins (see the COLLISION note on `BUILTIN_TOOL_PERMISSION_KIND`).
   * A kind with zero or one sibling here is unambiguous and never triggers
   * the conservative all-siblings-enabled rule.
   */
  private readonly _kindSiblings: ReadonlyMap<string, readonly string[]>;

  /**
   * Handler-backed tools this instance owns, fixed at construction
   * (SYS-REQ-028a). Keyed by name; `_createConfig()` derives the SDK's
   * `tools` dispatch array from this map's values every time, but the map's
   * contents themselves never change post-construction.
   */
  private readonly _customTools: ReadonlyMap<string, Tool>;

  /**
   * The private, mutable "enabled subset" of `_allToolNames`
   * (SYS-REQ-028c). All tools are enabled by default immediately after
   * construction. Mutated only by `enableTools`/`disableTools`, and read
   * fresh -- never from a snapshot -- inside `onPermissionRequest` on every
   * single call (SYS-REQ-028k), so a mutation made after one in-flight
   * call's permission check has already run does not affect that call, but
   * does affect the next one.
   */
  private readonly _enabledTools: Set<string>;

  /**
   * Caller-supplied additional instructions, plain text only, folded into
   * `systemMessage` at session creation. Changing this after a session has
   * started does not retroactively change the frozen `systemMessage`
   * (SYS-REQ-028g/h) -- see `_frozenSystemMessage`.
   */
  private _systemPrompt: string | undefined = undefined;

  private _modelName: string | undefined = undefined;

  /**
   * The live SDK session backing this wrapper, once `sendAndWait()` has been
   * called at least once. `undefined` here is precisely what tells
   * `sendAndWait()` to create instead of resume (SYS-REQ-028f: construction
   * always results in `createSession`, never a resume).
   */
  private _session: CopilotSession | undefined = undefined;

  /**
   * The `systemMessage` passed on session *creation*. Frozen the moment
   * `createSession` is called, and reused verbatim on every subsequent
   * `resumeSession` call (SYS-REQ-028g/028h) -- `resumeSession` does not
   * inherit `systemMessage` from the session it's resuming (issue #208), so
   * this is what `sendAndWait()`'s resume branch re-sends. Also kept so
   * `_createConfig()`'s output (read by tests, or anything inspecting config
   * post-creation) never disagrees with what was actually sent at creation,
   * regardless of any `setSystemPrompt` call made afterward.
   */
  private _frozenSystemMessage: SessionConfig['systemMessage'] | undefined = undefined;

  /**
   * Snapshot of `_systemPrompt` as of the last turn actually sent to the SDK
   * (create or resume). Diffed against current state in `sendAndWait()` to
   * decide whether a system-prompt-update notice belongs in this turn's
   * prompt. Tool enablement is NOT tracked here -- the enablement notice is
   * unconditional every turn (SYS-REQ-028i), so there is nothing to diff.
   */
  private _announcedSystemPrompt: string | undefined = undefined;

  /**
   * `_client` is optional at construction so existing `_createConfig()`-only
   * call sites (which never call `sendAndWait`) don't need to supply one;
   * `sendAndWait()` throws immediately if it's missing.
   *
   * `toolsConfig` is the ONLY place a tool schema can be declared
   * (SYS-REQ-028a) -- there is no constructor overload or later method that
   * accepts one. All tools are enabled by default immediately after
   * construction (SYS-REQ-028c).
   */
  constructor(
    private readonly _client?: CopilotClient,
    toolsConfig: SessionWrapperToolsConfig = {},
    private readonly _baseConfig: SessionWrapperBaseConfig = {}
  ) {
    const builtins = [...(toolsConfig.builtins ?? [])];
    const customEntries: [string, Tool][] = (toolsConfig.custom ?? []).map((tool) => [tool.name, tool]);
    this._customTools = new Map(customEntries);
    this._allToolNames = [...builtins, ...this._customTools.keys()];
    this._allToolNamesSet = new Set(this._allToolNames);
    this._enabledTools = new Set(this._allToolNames);

    const kindSiblings = new Map<string, string[]>();
    for (const name of builtins) {
      const kind = BUILTIN_TOOL_PERMISSION_KIND[name];
      if (kind === undefined) {
        continue;
      }
      const siblings = kindSiblings.get(kind) ?? [];
      siblings.push(name);
      kindSiblings.set(kind, siblings);
    }
    this._kindSiblings = kindSiblings;
  }

  /**
   * Read-only view of the live SDK session this wrapper is currently
   * holding, or `undefined` before the first `sendAndWait()` call
   * (SYS-REQ-028f: construction never creates a session by itself).
   *
   * This is read-only exposure of a session the wrapper already created
   * itself -- not a way to inject config onto a session it didn't create --
   * so it does not reopen the #327 "no side door" guarantee. As of #346,
   * this getter is no longer needed for event-listener attachment (tool-call
   * tracking, stall tracking, etc.) -- use the `listeners` parameter on
   * `sendAndWait()` instead, which subscribes/unsubscribes internally and
   * never hands the caller a `CopilotSession` reference. The getter remains
   * exposed only for the small number of callers that need lifecycle control
   * (`.disconnect()`) rather than event observation -- see the TODO below,
   * which is now narrower than before but still open.
   */
  // TODO(#78): audit flags SYS-REQ-028j tension: the spec text says any
  // module other than SessionWrapper reading/writing the CopilotSession
  // directly is a violation, with no read-only carve-out. As of #346, event-
  // listener attachment no longer needs this getter (see `sendAndWait`'s
  // `listeners` parameter, which subscribes internally). What remains is
  // narrower: a few callers (gateLoop.ts, toolCallEnforcement.ts) still read
  // this getter specifically to call `.disconnect()` on abort. Not resolving
  // now per owner direction (spec modifications are forbidden without
  // sign-off) -- needs a decision on whether SYS-REQ-028j should be amended
  // to carve out this narrower disconnect-only case, or whether `disconnect`
  // should become a `SessionWrapper`-owned method instead (mirroring how
  // `listeners` internalized the event-observation case).
  get session(): CopilotSession | undefined {
    return this._session;
  }

  /**
   * Adopts an already-created `CopilotSession` (e.g. from
   * `createHardenedSession`) into a new `SessionWrapper`, so callers that
   * must create their session through a `SessionPolicy` (audit-codebase.ts,
   * run-issue-task.ts, gateLoop.ts's SYS-REQ-004 retry site -- see issue
   * #359) can still use `runForcedToolTurn`/`runForcedToolTurnUntilTimeout`.
   *
   * This is an escape hatch, not a general-purpose constructor path: it
   * exists only because `SessionWrapper` cannot itself express
   * `SessionPolicy`'s `autoApprovedTools`/`onPermissionRequest` gating
   * (that enforcement already happened at `createSession` time and is
   * baked into `session`). `toolsConfig`/`baseConfig` must describe the
   * SAME tool set the session was actually created with -- they are only
   * used for this wrapper's own bookkeeping (`_allToolNames`,
   * `enableTools`/`disableTools` restriction between nudge retries) and
   * for resend-on-resume (`_createConfig()`), not to re-derive permissions.
   *
   * `frozenSystemMessage` must be the exact `systemMessage` value sent at
   * the session's original creation -- `resumeSession` does not inherit it
   * (issue #208), so this is what every subsequent nudge/stall retry
   * re-sends. Passing anything else silently drops the original prompt on
   * the first retry.
   *
   * TODO(#78): audit flags SYS-REQ-028f tension: the spec states
   * constructing a new `SessionWrapper` shall always result in
   * `client.createSession(...)`, never a resume, with resuming only
   * happening by reusing the wrapper instance that did the creating. This
   * `adopt()` escape hatch builds a *new* wrapper around a session it did
   * not create, so its first `sendAndWait()` always takes the resume path.
   * Not resolving now per owner direction (spec modifications are
   * forbidden without sign-off) -- needs a decision on whether
   * SYS-REQ-028f should be amended to document this escape hatch as an
   * explicit carve-out, or whether an alternative should replace it.
   */
  static adopt(
    session: CopilotSession,
    client: CopilotClient,
    toolsConfig: SessionWrapperToolsConfig,
    baseConfig: SessionWrapperBaseConfig,
    modelName: string,
    frozenSystemMessage: SessionConfig['systemMessage'] | undefined,
  ): SessionWrapper {
    const wrapper = new SessionWrapper(client, toolsConfig, baseConfig);
    wrapper._session = session;
    wrapper._frozenSystemMessage = frozenSystemMessage;
    wrapper._modelName = modelName;
    // Prevents a spurious "system prompt changed" notice on the first
    // resume: there is no prior wrapper-issued turn to have diverged from,
    // since the adopted session's initial prompt was sent by
    // `createHardenedSession`, not this wrapper.
    wrapper._announcedSystemPrompt = wrapper._systemPrompt;
    return wrapper;
  }

  /**
   * Enables one or more construction-time tools (SYS-REQ-028c). Mutates only
   * the private enabled subset -- the wire-level `tools`/`availableTools`
   * sent to the SDK never change (SYS-REQ-028/028d-1). If called after a
   * session has started, never rejected -- takes effect starting the next
   * `onPermissionRequest` evaluation, not the in-flight call
   * (SYS-REQ-028k).
   *
   * Throws synchronously, with no partial state change, if any name was not
   * supplied at construction (SYS-REQ-028b): every name is validated before
   * any mutation is applied.
   */
  enableTools(...names: readonly string[]): this {
    this._setEnablement(names, true);
    return this;
  }

  /**
   * Disables one or more construction-time tools -- the counterpart to
   * `enableTools`. See `enableTools` for the atomicity/timing guarantees
   * (SYS-REQ-028b/c/k), which apply identically here.
   */
  disableTools(...names: readonly string[]): this {
    this._setEnablement(names, false);
    return this;
  }

  private _setEnablement(names: readonly string[], enabled: boolean): void {
    const methodName = enabled ? 'enableTools' : 'disableTools';
    for (const name of names) {
      if (!this._allToolNamesSet.has(name)) {
        throw new Error(
          `SessionWrapper.${methodName}: unknown tool '${name}' -- it was not supplied to the constructor's ` +
            'toolsConfig, and no tool can be added after construction (SYS-REQ-028/028a).'
        );
      }
    }
    // Names are pre-validated above (SYS-REQ-028b: throw synchronously, no
    // partial state change) -- this loop cannot fail partway through.
    for (const name of names) {
      if (enabled) {
        this._enabledTools.add(name);
      } else {
        this._enabledTools.delete(name);
      }
    }
  }

  /**
   * Sets the caller's additional operating instructions, folded into
   * `systemMessage` at session creation. If called after a session has
   * started, never rejected -- but since `systemMessage` is frozen at
   * creation and never re-sent on resume (SYS-REQ-028g/h), a change made
   * post-creation has no effect on the live session; it only relays via the
   * appended system-prompt-update notice as a plain-text signal, same as any
   * other post-creation drift.
   */
  setSystemPrompt(content: string | undefined): this {
    this._systemPrompt = content;
    return this;
  }

  /**
   * Replaces the session's model name. If called after a session has
   * started, it will have no effects.
   */
  setModelName(modelName: string): this {
    this._modelName = modelName;
    return this;
  }

  /**
   * Freshly evaluates a `PermissionRequest` against the CURRENT enabled
   * subset (SYS-REQ-028d/028k) -- reads `this._enabledTools` live on every
   * invocation rather than closing over a snapshot, so a mutation that lands
   * between two calls to the same tool is honored on the second call even
   * within the same turn, while a call whose permission check already ran is
   * unaffected by a mutation that arrives afterward.
   *
   * Handles the `BUILTIN_TOOL_PERMISSION_KIND` collision (see its doc
   * comment): if the resolved `requestedTool` is a `kind` shared by more
   * than one construction-time built-in (`_kindSiblings`), the request is
   * approved only when EVERY sibling sharing that kind is currently enabled
   * -- there is no way to tell from the request alone which specific
   * sibling actually issued it, so approving when even one sibling is
   * disabled risks silently granting a disabled tool's call, which
   * SYS-REQ-028d forbids. For a `requestedTool` with zero or one sibling
   * (the common case), this reduces to the original single-name check.
   */
  private _onPermissionRequest = async (
    req: PermissionRequest,
    _invocation: { sessionId: string }
  ): Promise<PermissionRequestResult> => {
    const requestedTool = extractRequestedToolName(req);
    const siblings = this._kindSiblings.get(requestedTool);
    const isApproved =
      siblings !== undefined && siblings.length > 0
        ? siblings.every((name) => this._enabledTools.has(name))
        : this._enabledTools.has(requestedTool);
    if (isApproved) {
      return { kind: 'approve-once' };
    }
    return {
      kind: 'reject',
      feedback: `Tool '${requestedTool}' is not currently enabled for this session.`,
    };
  };

  /**
   * The single, non-split derivation point for everything the SDK needs to
   * create (or, for testing/inspection purposes, describe) this session:
   * `availableTools` and `tools` are always the FULL construction-time list
   * (SYS-REQ-028/028a/028d-1) -- never narrowed to the enabled subset, which
   * is enforced exclusively inside `onPermissionRequest`
   * (SYS-REQ-028d).
   *
   * `systemMessage` is the one field with creation-vs-later-call asymmetry:
   * once a session exists, `_frozenSystemMessage` (set by `sendAndWait` on
   * creation) is returned as-is rather than re-derived, so this method's
   * output never disagrees with what was actually sent at creation.
   */
  _createConfig(): Pick<SessionConfig, 'availableTools' | 'tools' | 'systemMessage' | 'model'> & {
    autoApproveAll: false;
    onPermissionRequest: (
      req: PermissionRequest,
      invocation: { sessionId: string }
    ) => Promise<PermissionRequestResult>;
  } {
    return {
      // Fixed at construction (SYS-REQ-028/028a) -- NOT derived from
      // `_enabledTools`. This is what makes the wire-level schema immutable
      // across resume regardless of any `enableTools`/`disableTools` call.
      availableTools: this._allToolNames as SessionConfig['availableTools'],
      tools: [...this._customTools.values()] as SessionConfig['tools'],
      systemMessage: this._frozenSystemMessage ?? buildCustomizeSystemMessage(this._systemPrompt),
      model: this._modelName,
      autoApproveAll: false,
      onPermissionRequest: this._onPermissionRequest,
    };
  }

  /**
   * Owns the full session lifecycle (SYS-REQ-028e): decides internally
   * whether to create a new SDK session or resume the one this instance
   * already owns, a decision invisible to the caller. Construction always
   * results in `createSession` on the first call -- resuming only ever
   * happens through reusing this same instance (SYS-REQ-028f).
   *
   * On resume, the config fields passed to the SDK are `onPermissionRequest`
   * (SYS-REQ-028g), plus `tools`/`availableTools`/`systemMessage` re-sent
   * byte-identical to what creation sent (see the resume-branch comment
   * below for why) -- `model` and any other `_baseConfig` field are omitted,
   * since none of them may legitimately change across resume under this
   * spec and the SDK does retain them from the session it's resuming.
   *
   * The per-turn enablement notice (SYS-REQ-028i/028l) is prepended to every
   * outgoing turn, including the first -- not only turns following a
   * mutation.
   */
  async sendAndWait(
    prompt: string | MessageOptions,
    timeout?: number,
    /**
     * Event listeners scoped to this single call only. Subscribed to the
     * live session right after it's created/resumed for this call, before
     * the prompt is sent (so nothing fired during the turn is missed --
     * see the `session` getter's doc comment), and unconditionally
     * unsubscribed before this method returns or throws. Nothing persists
     * across calls: pass the same listeners again on the next
     * `sendAndWait()` if they're still needed (e.g. every turn of a loop),
     * including across a resume that produces a brand-new `CopilotSession`
     * object -- there is no reattachment to reason about, since each call
     * subscribes fresh. Accepts either a type-filtered entry (`{ type,
     * handler }`, mirrors `CopilotSession.on(type, handler)`) or an
     * all-events entry (`{ handler }`, mirrors `CopilotSession.on(handler)`)
     * for callers that need to observe every event regardless of type. This
     * is `SessionWrapper`'s only sanctioned path for observing session
     * events (SYS-REQ-028j): the caller never receives a `CopilotSession`
     * reference to call `.on()` on directly.
     */
    listeners?: SessionListenerEntry[],
    /**
     * Fired synchronously with just the id of the session this call just
     * created or resumed -- before the prompt is sent, same timing as
     * `listeners` above. Exists because some callers (e.g. correlating an
     * outbound request with a global, or a stall-recovery loop that needs
     * to know a session existed even if the call that used it never
     * resolves) need to know a session came into being independent of
     * whether this call ever settles. Unlike `listeners`, this never hands
     * back anything beyond the id string -- also SYS-REQ-028j-compliant,
     * just narrower than the general event-observation case.
     */
    onSessionId?: (sessionId: string) => void
  ): Promise<AssistantMessageEvent | undefined> {
    if (!this._client) {
      throw new Error('SessionWrapper.sendAndWait: no CopilotClient was supplied to this instance.');
    }
    if (!this._modelName) {
      throw new Error('SessionWrapper.sendAndWait: no model name was set. Call setModelName() first.');
    }

    const enabledSubset = this._allToolNames.filter((name) => this._enabledTools.has(name));
    const noticeParts = [buildEnablementNotice(enabledSubset)];
    // Only ever relevant on resume: on creation there is no "last turn" to
    // have diverged from, since the caller's current `_systemPrompt` is
    // exactly what's about to be folded into `systemMessage` for the first
    // time (via `buildCustomizeSystemMessage` below). Computing this
    // unconditionally would fire a misleading "changed since last turn"
    // notice on turn one whenever `setSystemPrompt` was called before the
    // first `sendAndWait` -- there was no previous turn for it to have
    // changed since.
    const isResume = this._session !== undefined;
    if (isResume) {
      const systemPromptNotice = buildSystemPromptUpdateNotice(this._announcedSystemPrompt, this._systemPrompt);
      if (systemPromptNotice) {
        noticeParts.push(systemPromptNotice);
      }
    }
    const notice = noticeParts.join('\n\n');

    const effectivePrompt: string | MessageOptions =
      typeof prompt === 'string' ? `${notice}\n\n${prompt}` : { ...prompt, prompt: `${notice}\n\n${prompt.prompt}` };

    if (!this._session) {
      // Creating: `config.systemMessage` becomes the permanent prefix for
      // this session's life -- freeze it now, before it's ever sent, so
      // every later resume (which never re-sends it) is describable as
      // "the same value" by `_createConfig()`.
      const config = this._createConfig();
      this._frozenSystemMessage = config.systemMessage;
      this._session = await this._client.createSession({ ...this._baseConfig, ...config });
    } else {
      // Resuming: `onPermissionRequest` is the only field this spec requires
      // (SYS-REQ-028g) to differ in *purpose* across resume, but SYS-REQ-028g
      // also carves out an exception for fields "the SDK requires ... to be
      // present" -- sent "byte-identical to what was sent at creation".
      // Verified against the live SDK: `tools` and `availableTools` fall
      // into that carve-out for handler-backed custom tools. The SDK does
      // not retain custom tool handlers across `resumeSession` the way it
      // retains built-ins by name -- omitting them makes the SDK believe the
      // custom tool no longer exists and short-circuit with its own "does
      // not exist" rejection, which never reaches `_onPermissionRequest` and
      // so bypasses SYS-REQ-028d enforcement entirely for custom tools.
      // Re-sending both here byte-identical to `_createConfig()`'s
      // construction-time values keeps this compliant with SYS-REQ-028/
      // 028d-1 (the wire-level set is unchanged, just re-declared).
      //
      // `systemMessage` falls into that same carve-out, for a different
      // reason (issue #208, see AGENTS.md "resumeSession() drops the system
      // prompt unless you re-pass it", and the docstring on
      // `CopilotClient.resumeSession` in boundary.ts): `resumeSession` does
      // NOT inherit `systemMessage` from the session being resumed -- the
      // SDK's base `resumeSession` simply doesn't carry it forward. Omitting
      // it here would silently fall back to the SDK's full default
      // `copilot-cli` system prompt for the rest of the turn, quietly
      // discarding SYS-REQ-028h's frozen prompt (and the tool-usage contract
      // `buildEnablementNotice` assumes is still in effect) without any
      // error. `this._frozenSystemMessage` is exactly the byte-identical
      // value creation sent, so reuse it directly rather than recomputing
      // via `_createConfig()` (which would derive from the possibly-mutated
      // `_systemPrompt` instead of the frozen one).
      //
      // `autoApproveAll: false` must also be explicit here: `boundary.ts`'s
      // `CopilotClient.resumeSession` override defaults `autoApproveAll` to
      // `true` whenever it's omitted, which swaps in its own always-approve
      // handler and silently discards whatever `onPermissionRequest` we pass
      // -- defeating SYS-REQ-028d enforcement on every resumed turn (the
      // disabled-tool integration tests catch this: the tool actually ran).
      const resumeConfig = this._createConfig();
      this._session = await this._client.resumeSession(this._session.sessionId, {
        onPermissionRequest: this._onPermissionRequest,
        autoApproveAll: false,
        tools: resumeConfig.tools,
        availableTools: resumeConfig.availableTools,
        systemMessage: this._frozenSystemMessage,
      });
    }

    this._announcedSystemPrompt = this._systemPrompt;

    onSessionId?.(this._session.sessionId);

    const unsubscribers = (listeners ?? []).map((l) =>
      // TS can't correlate `l.type` and `l.handler` back to the same `K`
      // here: `SessionListenerEntry`'s distribution happens per array
      // *entry* (so each entry's `type`/`handler` genuinely do match at
      // the call site that constructed it), but once entries are merged
      // into one array and iterated, `l` widens back to the whole union
      // and this correlation is lost from TS's perspective, not from
      // reality's. Safe by construction: every entry is still exactly the
      // `{ type, handler }` pair its caller wrote.
      'type' in l ? this._session!.on(l.type, l.handler as TypedSessionEventHandler<typeof l.type>) : this._session!.on(l.handler)
    );
    try {
      // TS can't resolve `session.sendAndWait`'s overloads against a `string |
      // MessageOptions` union directly (call site, not signature, must narrow) --
      // this branch exists only for that; both arms call the same thing.
      return await (typeof effectivePrompt === 'string'
        ? this._session.sendAndWait(effectivePrompt, timeout)
        : this._session.sendAndWait(effectivePrompt, timeout));
    } finally {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    }
  }
}
