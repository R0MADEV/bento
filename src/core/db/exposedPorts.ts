// Container-side ports from a Docker PORTS string, whether merely exposed
// ("3306/tcp") or published ("0.0.0.0:3307->3306/tcp"). The port right before
// "/tcp" is always the container's own port in both forms.
export function exposedPorts(ports: string): number[] {
  const matches = [...ports.matchAll(/(\d+)\/(?:tcp|udp)/g)].map(m => Number(m[1]))
  return [...new Set(matches)]
}
