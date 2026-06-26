// Pure auth helpers, kept koishi-free so they are unit-testable in vitest
// (importing the plugin index pulls in koishi's loader, which breaks under vitest).

export function basicAuth(username: string, password: string): { Authorization: string } {
  return {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
  }
}
