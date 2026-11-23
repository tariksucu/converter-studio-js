/**
 * The official JavaScript and TypeScript client for the Converter Studio API
 * (https://converter.studio). Convert iPhone photos (HEIC), camera RAW photos, videos, audio,
 * documents, spreadsheets, presentations, e-books, subtitles, fonts, data files and archives
 * (67 formats) from Node.js, Deno, Bun or a browser. The conversion runs on Converter Studio's
 * servers, so there is nothing else to install.
 *
 * @example
 * ```ts
 * import { ConverterStudio } from 'converter-studio';
 *
 * const client = new ConverterStudio(); // the key comes from CONVERTER_STUDIO_API_KEY
 * const conversion = await client.convert('IMG_1234.HEIC', 'jpg');
 * await client.download(conversion, 'photos/'); // photos/IMG_1234.jpg
 * ```
 *
 * Documentation: https://converter.studio/developers
 *
 * @module
 */

export {
  API_KEY_ENV,
  BASE_URL_ENV,
  ConverterStudio,
  DEFAULT_BASE_URL,
  type ClientOptions,
  type ConvertOptions,
  type CreateConversionParams,
  type DownloadOptions,
  type FetchLike,
  type RequestOptions,
  type UploadOptions,
  type WaitOptions,
} from './client.ts';
export {
  CALLBACK_EVENTS,
  parseCallback,
  type CallbackEvent,
  type CallbackEventType,
} from './callback.ts';
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConfirmationRequiredError,
  ConflictError,
  ConversionError,
  ConversionFailedError,
  ConversionTimeoutError,
  ConverterStudioError,
  FileTooLargeError,
  GoneError,
  InsufficientCreditsError,
  MissingApiKeyError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  UnprocessableError,
  type APIErrorDetails,
} from './errors.ts';
export type { Source } from './files.ts';
export {
  FINISHED_STATUSES,
  SETTLED_STATUSES,
  type Account,
  type Allowance,
  type Conversion,
  type ConversionOptions,
  type ConversionStatus,
  type ErrorInfo,
  type Format,
  type ParamValue,
  type Upload,
  type Wallet,
} from './models.ts';
export { VERSION } from './version.ts';
