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
                description: "How serious the finding is. Purely for comment formatting -- does not gate anything."
              },
              file: { type: "string", description: "File path the finding applies to." },
              line: { type: "number", description: "Line number in the new version of the file, if applicable." },
              message: { type: "string", description: "Description of the issue or suggestion." }
            },
            required: ["severity", "file", "message"]
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
