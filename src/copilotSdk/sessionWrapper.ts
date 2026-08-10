import { PermissionRequest, PermissionRequestResult, SessionConfig } from './boundary';

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
 * Private state, builder-style mutators (SYS-REQ-027, 027a, 027a-1), and
 * config derivation (`_createConfig()`, SYS-REQ-027b/h/i/j) live here. The
 * create/resume lifecycle (`sendAndWait()`, SYS-REQ-027c/d) and post-start
 * mutator behavior (SYS-REQ-027f) are still out of scope and tracked in
 * separate issues -- nothing below calls `_createConfig()` yet.
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
   * Adds one or more tools to the session's tool list. Builder-style: only
   * ever grows `_tools`, never replaces it wholesale (SYS-REQ-027a).
   */
  addTools(...names: readonly string[]): this {
    for (const name of names) {
      this._tools.add(name);
    }
    return this;
  }

  /**
   * Removes one or more tools from the session's tool list. The
   * counterpart builder-style mutator to `addTools` (SYS-REQ-027a).
   */
  removeTools(...names: readonly string[]): this {
    for (const name of names) {
      this._tools.delete(name);
    }
    return this;
  }

  /** Replaces the session's system prompt (SYS-REQ-027a). */
  setSystemPrompt(systemPrompt: SessionConfig['systemMessage']): this {
    this._systemPrompt = systemPrompt;
    return this;
  }

  /** Replaces the session's model name (SYS-REQ-027a). */
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
   * Called fresh at the start of every turn (by `sendAndWait`, tracked in a
   * separate issue) -- never cached -- so a tool removed via `removeTools`
   * is denied starting next turn without needing any other bookkeeping
   * (SYS-REQ-027j).
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
}
