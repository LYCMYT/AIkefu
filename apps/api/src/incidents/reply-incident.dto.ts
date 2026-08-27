/** Maps Prisma storage names to the public Incident vocabulary. */
export function toReplyIncidentDto(incident: object): Record<string, unknown> {
  const { replyMessageId, originalAnswerSnapshot, regressionCaseJson, ...rest } = incident as Record<string, unknown>;
  return { ...rest, replyId: replyMessageId, originalAnswer: originalAnswerSnapshot, regressionCase: regressionCaseJson ?? undefined };
}
