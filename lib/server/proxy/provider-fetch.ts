import "server-only"

import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici"

type ProviderFetchInit = RequestInit & { dispatcher?: Dispatcher }
export type ProviderFetch = (
  input: string | URL,
  init?: ProviderFetchInit,
) => Promise<Response>

const providerDispatcher = new Agent({ allowH2: false })

const defaultProviderFetch: ProviderFetch = async (input, init) => {
  const undiciInit = init as unknown as Parameters<typeof undiciFetch>[1]
  return (await undiciFetch(input, undiciInit)) as unknown as Response
}

let providerFetchImpl = defaultProviderFetch

export function fetchProvider(
  input: string | URL,
  init: ProviderFetchInit = {},
): Promise<Response> {
  const requestInit = init.dispatcher
    ? init
    : { ...init, dispatcher: providerDispatcher }
  return providerFetchImpl(input, requestInit)
}

export function setProviderFetchForTesting(fetchImpl?: ProviderFetch) {
  const previous = providerFetchImpl
  providerFetchImpl = fetchImpl ?? defaultProviderFetch
  return previous
}
