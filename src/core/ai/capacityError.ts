// A token/rate/usage limit means the current agent can't continue — worth
// switching to a different agent rather than retrying the same one.
export function isCapacityError(message: string): boolean {
  return /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|usage limit|quota|out of tokens|token limit|context (?:length|window)|maximum context|prompt is too long|too long/i.test(message)
}
