export type ServiceStatus = 'checking' | 'ok' | 'unavailable'

function reportsOk(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok'
  )
}

export async function readServiceStatus(): Promise<ServiceStatus> {
  try {
    const response = await fetch('/api/health')
    const body: unknown = await response.json()
    return reportsOk(body) ? 'ok' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
