import { CustomApiError } from "./customApiError";
import { BASE_URL } from "./constants";

const { PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET } = process.env;

type AuthTokenSuccessResponse = {
  scope: string;
  access_token: string;
  token_type: string;
  app_id: string;
  expires_in: number;
  nonce: string;
};

type AuthTokenErrorResponse = {
  error: string;
  error_description: string;
};

// Access tokens last about 9 hours. Cache one in memory and refresh it shortly
// before it expires, instead of requesting a new token on every API call.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
let cachedToken: { accessToken: string; expiresAt: number } | undefined;

export async function getFullScopeAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  const encodedClientCredentials = Buffer.from(
    `${PAYPAL_SANDBOX_CLIENT_ID}:${PAYPAL_SANDBOX_CLIENT_SECRET}`,
  ).toString("base64");

  const response = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    body: "grant_type=client_credentials",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Language": "en_US",
      Authorization: `Basic ${encodedClientCredentials}`,
    },
  });

  const result = await response.json();

  if (!response.ok) {
    const { error_description } = result as AuthTokenErrorResponse;
    throw new CustomApiError({
      message: error_description || "Failed to create full scope access token",
      statusCode: response.status,
      result,
    });
  }

  const { access_token, expires_in } = result as AuthTokenSuccessResponse;
  cachedToken = {
    accessToken: access_token,
    expiresAt: Date.now() + expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
  };
  return access_token;
}
