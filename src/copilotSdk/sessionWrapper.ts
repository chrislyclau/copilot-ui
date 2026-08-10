import { SessionConfig } from './boundary';

/**
 * `SessionWrapper` — replaces `hardenedSession.ts` (see README.md
 * "SessionWrapper — Spec Draft (EARS)", SYS-REQ-027 family). Built in
 * isolation per the spec's hotswap migration strategy: this file has zero
 * imports from or into `hardenedSession.ts`, and nothing in production
 * wires to it yet.
 *
 * This is the skeleton only (SYS-REQ-027, 027a, 027a-1): private state and
 * builder-style mutators. Config derivation (`_createConfig()`,
 * SYS-REQ-027b), the create/resume lifecycle (`sendAndWait()`,
 * SYS-REQ-027c/d), and post-start mutator behavior (SYS-REQ-027f) are all
 * out of scope here and tracked in separate issues.
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
}
