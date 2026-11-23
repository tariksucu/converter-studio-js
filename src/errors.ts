/**
 * The errors this package throws. Each derives from {@linkcode ConverterStudioError}, and its
 * `message` is always a sentence meant for people: for API errors, the API's own message.
 *
 * @module
 */

import type { Conversion, ParamValue } from './models.ts';

/** The base class of every error this package throws. */
export class ConverterStudioError extends Error {
  /**
   * An error with a sentence for people.
   *
   * @param message A sentence for people.
   * @param options The error that caused it (`cause`).
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No API key was given, and `CONVERTER_STUDIO_API_KEY` is not set. */
export class MissingApiKeyError extends ConverterStudioError {}

/** The API could not be reached, or the connection broke (after the retries). */
export class APIConnectionError extends ConverterStudioError {}

/** The API did not answer in time (after the retries). */
export class APITimeoutError extends APIConnectionError {}

/** What an {@linkcode APIError} carries besides its message. */
export interface APIErrorDetails {
  /** The HTTP status. */
  readonly status: number;
  /** The API's error code, or `null` for an answer that did not come from the API itself. */
  readonly code: string | null;
  /** The values in the message. */
  readonly params?: Readonly<Record<string, ParamValue>> | undefined;
  /** The answer's headers, with lower-case names. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * The API answered with an error. `code` is the API's stable error code (`invalidApiKey`,
 * `notEnoughCredits`, `unsupportedConversion`...), `message` its English sentence for people and
 * `params` the values in it. `code` is `null` only when the answer did not come from the API
 * itself (a proxy's error page).
 */
export class APIError extends ConverterStudioError {
  /** The HTTP status. */
  readonly status: number;
  /** The API's error code. */
  readonly code: string | null;
  /** The values in the message (`needed`, `balance`, `maxSize`...). */
  readonly params: Readonly<Record<string, ParamValue>>;
  /** The answer's headers, with lower-case names. */
  readonly headers: Readonly<Record<string, string>>;

  /**
   * An error the API answered.
   *
   * @param message The API's sentence for people.
   * @param details The status, code, params and headers.
   */
  constructor(message: string, details: APIErrorDetails) {
    super(message);
    this.status = details.status;
    this.code = details.code;
    this.params = { ...details.params };
    this.headers = { ...details.headers };
  }
}

/** 400: the request was not right (`invalidRequest`, `invalidUrl`, `invalidCallbackUrl`...). */
export class BadRequestError extends APIError {}

/** 401: the API key does not work (wrong or deleted). */
export class AuthenticationError extends APIError {}

/** 402: not enough credits for this conversion (`params`: `needed`, `balance`). */
export class InsufficientCreditsError extends APIError {}

/** 403: the plan does not include this. */
export class PermissionDeniedError extends APIError {}

/** 404: no such conversion or upload on this account. */
export class NotFoundError extends APIError {}

/** 409: the request conflicts with what is there (`idempotencyKeyReused`...). */
export class ConflictError extends APIError {}

/** 410: the result has been deleted (`fileExpired`). */
export class GoneError extends APIError {}

/** 413: the file is larger than the plan allows (`params`: `maxSize`). */
export class FileTooLargeError extends APIError {}

/** 422: the file cannot be converted this way (`unsupportedConversion`...). */
export class UnprocessableError extends APIError {}

/** 429: too many requests; `retryAfter` says how many seconds to wait, when known. */
export class RateLimitError extends APIError {
  /** Seconds to wait before trying again, from the `Retry-After` header. */
  readonly retryAfter: number | null;

  /**
   * A 429 answer.
   *
   * @param message The API's sentence for people.
   * @param details The status, code, params and headers, and the `Retry-After` in seconds.
   */
  constructor(message: string, details: APIErrorDetails & { readonly retryAfter?: number | null }) {
    super(message, details);
    this.retryAfter = details.retryAfter ?? null;
  }
}

/** 5xx: the service is busy or failed (`serverBusy`); trying again later may work. */
export class ServerError extends APIError {}

/** A conversion ended without a result, or did not end in time. */
export class ConversionError extends ConverterStudioError {
  /** The conversion as it was last seen. */
  readonly conversion: Conversion;

  /**
   * An error about a conversion.
   *
   * @param message A sentence for people.
   * @param conversion The conversion as it was last seen.
   */
  constructor(message: string, conversion: Conversion) {
    super(message);
    this.conversion = conversion;
  }
}

/**
 * The conversion failed, expired or was canceled; nothing is charged for a failure. `code` and
 * `message` are the API's (`conversionFailed`, `noText`, `wrongPassword`, `remoteNotFound`...).
 */
export class ConversionFailedError extends ConversionError {
  /** The API's code for the failure. */
  readonly code: string;
  /** The values in the message. */
  readonly params: Readonly<Record<string, ParamValue>>;

  /**
   * The error of a conversion that ended without a result, with the API's reason.
   *
   * @param conversion The conversion that ended without a result.
   */
  constructor(conversion: Conversion) {
    const error = conversion.error;
    let code: string;
    let message: string;
    if (error) {
      code = error.code;
      message = error.message;
    } else if (conversion.status === 'expired') {
      code = 'fileExpired';
      message = 'The result was deleted after its time ran out.';
    } else if (conversion.status === 'canceled') {
      code = 'canceled';
      message = 'The conversion was canceled; nothing was charged.';
    } else {
      code = 'conversionFailed';
      message = conversion.next || 'The conversion failed.';
    }
    super(message, conversion);
    this.code = code;
    this.params = { ...error?.params };
  }
}

/**
 * The conversion costs more than its `maxCredits`: it waits for
 * {@linkcode ConverterStudio.confirm}, and nothing has been charged.
 */
export class ConfirmationRequiredError extends ConversionError {
  /** The price in credits. */
  readonly credits: number | null;
  /** The most it could cost to go ahead on its own. */
  readonly maxCredits: number | null;

  /**
   * The error of a conversion that waits for a go-ahead, with its price.
   *
   * @param conversion The conversion that waits for a go-ahead.
   */
  constructor(conversion: Conversion) {
    super(
      `This conversion costs ${conversion.credits ?? '?'} credits, more than the ` +
        `${conversion.maxCredits ?? 0} allowed to go ahead on their own. Confirm it to start, ` +
        'or leave it: nothing has been charged.',
      conversion,
    );
    this.credits = conversion.credits;
    this.maxCredits = conversion.maxCredits;
  }
}

/**
 * The conversion did not finish in the time given. It may still finish: wait for it again, or
 * look it up later with {@linkcode ConverterStudio.getConversion}.
 */
export class ConversionTimeoutError extends ConversionError {}
