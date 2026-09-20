export function formatContextNarrowingPrompt(
  promptStr: string,
  failedGateName: string,
  failedGateFeedback: string,
  history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }> = []
): string {
  const historyContext = history.length > 0 
    ? `\n\n[Conversation History]\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}`
    : '';

  return `[Context-Narrowing Applied]\n\nOriginal Task: ${promptStr}${historyContext}\n\n[Feedback from Gate '${failedGateName}']\n${failedGateFeedback}\n\n[Instruction]\nAnalyze the feedback above and fix the corresponding files to resolve these specific defects. Ensure adherence to structural output requirements.`;
}

export function formatEscalationPrompt(
  promptStr: string,
  failedGateName: string,
  failedGateFeedback: string,
  history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }> = []
): string {
  const historyContext = history.length > 0 
    ? `\n\n[Conversation History]\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}`
    : '';

  return `Original request: ${promptStr}${historyContext}\n\nOur previous attempts failed validation check for '${failedGateName}'. Feedback/logs:\n${failedGateFeedback}\n\nPlease revise the implementation with premium attention and fix these issues completely.`;
}

export function formatHumanEscalationPrompt(
  promptStr: string,
  failedGateName: string,
  failedGateFeedback: string,
  humanFeedback: string
): string {
  return `Original request: ${promptStr}\n\nOur previous attempts failed validation check for '${failedGateName}'. Feedback/logs:\n${failedGateFeedback}\n\nThe human operator has provided the following guidance to correct this issue:\n${humanFeedback}\n\nPlease revise the implementation based on this guidance.`;
}

export function formatClarityCheckPrompt(goal: string): string {
  return `You are an Ambiguity Checker Agent. Your role is identify missing variables or contradictions in the user's technical goal.
Goal: "${goal}"
Evaluate the goal and return a clarity coefficient score and a list of missing variables using the submit_clarity_check tool.`;
}
