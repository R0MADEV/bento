// Jira Cloud REST auth: HTTP Basic with the account email and an API token
// (generated at id.atlassian.com → Security → API tokens).
export function basicAuth(email: string, token: string): string {
  return `Basic ${btoa(`${email}:${token}`)}`
}
