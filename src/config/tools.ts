export const RUN_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'run_terminal_docker',
    description: 'Executes an arbitrary terminal command or script securely inside an isolated, containerized environment. Use this for all file creations, terminal commands, or testing operations.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact raw bash instruction sequence to stream into the shell stdin.' },
        workingDir: { type: 'string', description: 'The relative or absolute target sub-directory context inside the container (default: "/workspace").' }
      },
      required: ['command']
    }
  }
};

export const submitAuditFindingsTool = {
  type: 'function',
  function: {
    name: "submit_audit_findings",
    description: "Submit structured verification feedback, logic checks, and compiler gate status.",
    parameters: {
      type: "object",
      properties: {
        pass: {
          type: "boolean",
          description: "True if all automated check constraints pass. False if issues or regressions persist."
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ['low', 'medium', 'high', 'critical']
              },
              file: {
                type: "string",
                description: 'The file path containing the issue.'
              },
              description: {
                type: "string",
                description: 'A clear description of the failure or required modification.'
              }
            },
            required: ["severity", "description"]
          }
        }
      },
      required: ["pass", "findings"]
    }
  }
};

export const COMPOSER_ROUTER_TOOL = {
  type: 'function',
  function: {
    name: 'initialize_blueprint',
    description: 'Classifies the user request and selects the appropriate verification blueprint and target directories.',
    parameters: {
      type: 'object',
      properties: {
        taskType: { 
          type: 'string', 
          enum: ['refactor', 'feature', 'test-only', 'style-only', 'audit-only'],
          description: 'The primary objective category of the request.'
        },
        targetDirectories: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'A list of specific directories targeted for modification or analysis.'
        }
      },
      required: ['taskType', 'targetDirectories']
    }
  }
};

export const submitSpecAuditTool = {
  type: 'function',
  function: {
    name: "submit_spec_audit",
    description: "Submit structural deviation checks based on architecture specs.",
    parameters: {
      type: "object",
      properties: {
        pass: {
          type: "boolean",
          description: "True if the code aligns with the architecture spec. False if there is a SPEC_VIOLATION."
        },
        violation_type: {
          type: "string",
          description: "Must be 'SPEC_VIOLATION' if pass is false, otherwise 'NONE'"
        },
        feedback: {
          type: "string",
          description: "Details regarding the alignment or violation."
        }
      },
      required: ["pass", "violation_type", "feedback"]
    }
  }
};

export const submitComplianceAuditTool = {
  type: 'function',
  function: {
    name: "submit_compliance_audit",
    description: "Submit the result of a PBI-level compliance audit: whether the PBI's accumulated diff (against trunk) satisfies the relevant subset of the spec, and a structured list of findings if not. Findings become new remediation tasks directly -- do not describe them as prose.",
    parameters: {
      type: "object",
      properties: {
        pass: {
          type: "boolean",
          description: "True if the PBI's diff fully satisfies the relevant spec requirements with no findings. False if there is at least one finding."
        },
        findings: {
          type: "array",
          description: "One entry per distinct issue found. Empty if pass is true. Each finding becomes a new remediation task within the same PBI.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short, human-readable title for the remediation task this finding will become."
              },
              description: {
                type: "string",
                description: "Concrete description of the gap or deviation, and what the remediation task must do to close it."
              }
            },
            required: ["title", "description"]
          }
        }
      },
      required: ["pass", "findings"]
    }
  }
};

export const submitPbiDerivationTool = {
  type: 'function',
  function: {
    name: "submit_pbi_derivation",
    description: "Submit the derived set of Product Backlog Items (PBIs) for a spec, including intra-batch dependency edges. This is a proposed set only -- nothing is persisted by this call.",
    parameters: {
      type: "object",
      properties: {
        pbis: {
          type: "array",
          description: "The proposed PBIs derived from the spec, in dependency-friendly order (a PBI should generally not depend on a PBI listed after it, though this is not strictly enforced).",
          items: {
            type: "object",
            properties: {
              batchId: {
                type: "string",
                description: "A short identifier unique within this batch (e.g. 'pbi-1'), used only to express dependsOn edges below. This is NOT a persisted database ID -- real pbiIds are assigned when the batch is accepted and persisted."
              },
              title: {
                type: "string",
                description: "Short, human-readable title for the PBI."
              },
              description: {
                type: "string",
                description: "A clear description of the scope and boundaries of this PBI."
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "blocked", "done"],
                description: "Initial status for a freshly derived PBI. Should almost always be 'pending' unless there is clear evidence in the repository that work has already started or finished."
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "List of batchId values (from this same batch only) that this PBI depends on. Empty array if none."
              }
            },
            required: ["batchId", "title", "description", "status", "dependsOn"]
          }
        }
      },
      required: ["pbis"]
    }
  }
};

export const submitCodeReviewTool = {
  type: 'function',
  function: {
    name: "submit_code_review",
    description: "Submit code review findings for the current PR diff.",
    parameters: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          description: "List of individual review findings.",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["blocking", "suggestion", "nit"],
                description: "How serious the finding is."
              },
              category: {
                type: "string",
                enum: ["bug", "security", "performance", "style", "other"],
                description: "Category of the finding. Use 'other' when none of bug/security/performance/style applies."
              },
              file: { type: "string", description: "File path the finding applies to." },
              line: { type: "number", description: "Line number in the new version of the file, if applicable." },
              message: { type: "string", description: "Description of the issue or suggestion." },
              status: {
                type: "string",
                enum: ["new", "still-open", "resolved"],
                description: "Set 'resolved' if the diff shows it has been fixed, 'still-open' if it persists, or 'new' if it's a blocking issue you're raising for the first time."
              }
            },
            required: ["severity", "file", "message", "status", "category"]
          }
        },
        summary: {
          type: "string",
          description: "One or two sentence overall summary of the PR's quality and the review outcome."
        }
      },
      required: ["findings", "summary"]
    }
  }
};

export const AMBIGUITY_CHECK_TOOL = {
  type: 'function',
  function: {
    name: 'submit_clarity_check',
    description: 'Submits a clarity assessment of the user project goal.',
    parameters: {
      type: 'object',
      properties: {
        score: { type: 'number', description: 'Clarity coefficient score (0.0 to 1.0).' },
        missingVariables: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'A list of items that are ambiguous or missing from the user request.'
        }
      },
      required: ['score', 'missingVariables']
    }
  }
};
