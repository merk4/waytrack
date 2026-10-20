export type ProviderErrorCode =
  /** Upstream asked us to slow down; retry after `retryAfterS`. */
  | 'rate_limited'
  /** Daily/monthly quota used up. */
  | 'quota_exhausted'
  /** Upstream down, misconfigured, or returned 5xx / network failure. */
  | 'unavailable'
  | 'timeout'
  /** Upstream answered with a payload we could not validate. */
  | 'bad_response'
  /** A requested point is not near any routable way. */
  | 'point_not_routable'
  /** Upstream rejected the request as invalid. */
  | 'invalid_request';

/**
 * Every provider failure is normalised to this. `message` is safe to log; it must
 * never contain credentials. User-facing text is produced by the HTTP layer.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;
  readonly retryAfterS: number | undefined;
  readonly pointIndex: number | undefined;

  constructor(
    provider: string,
    code: ProviderErrorCode,
    message: string,
    extra: { status?: number; retryAfterS?: number; pointIndex?: number; cause?: unknown } = {},
  ) {
    super(`${provider}: ${message}`, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.provider = provider;
    this.code = code;
    this.status = extra.status;
    this.retryAfterS = extra.retryAfterS;
    this.pointIndex = extra.pointIndex;
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable' || this.code === 'timeout';
  }
}
