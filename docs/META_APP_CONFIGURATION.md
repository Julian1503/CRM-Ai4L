# Meta app configuration for AI4L CRM

Use the **production** host shown below. The CRM uses one Meta OAuth flow to connect Facebook Pages and linked Instagram business accounts. The callback URL must match the URL registered in Meta exactly.

## URLs and domains

| Meta dashboard field | Enter | Notes |
| --- | --- | --- |
| App Display Name | `Ai4l CRM` | Public name of this Meta integration. |
| Contact Email | `info@ai4l.com.au` | Public contact supplied by Ai4l. |
| App Domains | `crm-ai4-l.vercel.app` | Hostname only; no scheme or slash. |
| Website URL / Site URL | `https://crm-ai4-l.vercel.app/login` | Public sign-in page; the CRM workspace itself requires an account. |
| Privacy Policy URL | `https://crm-ai4-l.vercel.app/privacy` | Public page created for this integration. |
| Terms of Service URL | `https://crm-ai4-l.vercel.app/terms` | Public page created for this integration. |
| User data deletion: **Data deletion instructions URL** | `https://crm-ai4-l.vercel.app/data-deletion` | Choose the instructions URL option, not a callback option. |
| Facebook Login for Business: **Valid OAuth Redirect URIs** | `https://crm-ai4-l.vercel.app/api/social/oauth/meta/callback` | Exact server callback; register it once for both Facebook Pages and linked Instagram accounts. |
| Redirect URI Validator | `https://crm-ai4-l.vercel.app/api/social/oauth/meta/callback` | If Meta offers a validator, check the same exact URL. |
| Deauthorize Callback URL | Leave blank | There is no deauthorization webhook endpoint yet. Do not use the OAuth callback or deletion instructions page here. |
| Data Deletion Callback URL / Data Deletion Request URL | Leave blank | The app provides a public instructions URL. It has no endpoint for signed deletion requests. |
| Webhooks Callback URL | Leave blank | The current integration does not subscribe to Meta webhooks. |
| JavaScript SDK allowed domains | Leave blank | The integration uses a server-side OAuth flow, not Meta's browser SDK. |

If the Meta dashboard offers both *Data deletion instructions URL* and *Data deletion callback URL*, select the first. If a dashboard field makes a callback mandatory for a selected use case, that use case needs a real signed-request endpoint and deletion workflow before it can be configured safely.

## Login settings

| Setting | Value |
| --- | --- |
| Client OAuth Login | On |
| Web OAuth Login | On |
| Enforce HTTPS | On |
| Valid OAuth Redirect URIs | The exact URL in the table above |
| Embedded Browser OAuth Login | Off, unless another client is added |

The Meta authorization flow currently requests `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, and `instagram_content_publish`. Request access to the permissions required for the features that will be released; availability may depend on Meta app review. Configure `META_APP_ID`, `META_APP_SECRET`, and, if using Facebook Login for Business, `META_LOGIN_CONFIG_ID` in the content engine. When `META_LOGIN_CONFIG_ID` is set, select the needed permissions in that Meta login configuration: the code omits the `scope` parameter in this mode. Set `NEXT_PUBLIC_APP_URL=https://crm-ai4-l.vercel.app` in the deployed CRM environment before building.

## Publication checklist

The public pages identify Ai4l as the operator in Australia and use `info@ai4l.com.au` for privacy and deletion requests, as supplied by the business owner. Confirm the privacy, terms, and deletion text with the business owner. Then deploy and open all three URLs in a private browser session to confirm they are readable without signing in. The current routes are source code until the deployment that contains them is live.
