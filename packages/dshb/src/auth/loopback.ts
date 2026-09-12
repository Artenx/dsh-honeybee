export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false
  let addr = address.trim().toLowerCase()
  const v4mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)
  if (v4mapped) addr = v4mapped[1]
  if (addr === '::1' || addr === '::') return true
  return /^127\./.test(addr)
}

export function isLoopbackHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false
  const authority = hostHeader.trim().toLowerCase()
  if (!authority) return false
  const host = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.split(':')[0]
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isLoopbackAddress(host)
}

export function isLoopbackRequest(
  remoteAddress: string | undefined | null,
  hostHeader: string | undefined | null,
): boolean {
  return isLoopbackAddress(remoteAddress) && isLoopbackHost(hostHeader)
}
