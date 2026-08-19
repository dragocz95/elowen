import type { HostedToolSearchProtocol } from './wireContract.js';

/** The hosted-tool-search handshake version the daemon currently speaks.
 *
 *  Separate from `wireContract.ts` because that file is compiled by BOTH toolchains and must contain no
 *  runtime value at all — `tests/contract/wireContractIsolation.test.ts` fails the build if it does, since
 *  a runtime export would make the web bundle actually execute the shared contract.
 *
 *  Annotated with the contract's own type rather than inferred, so changing the literal in one place and
 *  not the other is a compile error instead of a persisted capability that silently never matches again.
 *  A stored capability recorded under a different protocol is treated as unknown, which means a local
 *  fallback — never an unverified hosted route. */
export const HOSTED_TOOL_SEARCH_PROTOCOL: HostedToolSearchProtocol = 'hosted-tool-search-v1';
