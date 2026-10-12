# Meta app configuration for AI4L CRM

The production CRM is available on Railway and Vercel. Railway currently has `NEXT_PUBLIC_APP_URL=https://crm-ai4l-production.up.railway.app`; its Meta OAuth redirect therefore uses the **Railway CRM host**. The CRM uses one Meta OAuth flow to connect Facebook Pages and linked Instagram business accounts. Register the exact callback for every CRM host from which staff will start a connection.

## URLs and domains

| Meta dashboard field | Enter | Notes |
| --- | --- | --- |
| App Display Name | `Ai4l CRM` | Public name of this Meta integration. |
| Contact Email | `info@ai4l.com.au` | Public contact supplied by Ai4l. |
| App Domains | `crm-ai4l-production.up.railway.app` | Hostname only; no scheme or slash. Also add `crm-ai4-l.vercel.app` if staff will connect from Vercel. |
| Website URL / Site URL | `https://crm-ai4l-production.up.railway.app/login` | Public sign-in page of the Railway CRM. |
| Privacy Policy URL | `https://crm-ai4l-production.up.railway.app/privacy` | Public page created for this integration. |
| Terms of Service URL | `https://crm-ai4l-production.up.railway.app/terms` | Public page created for this integration. |
| User Support URL, if shown | `https://crm-ai4l-production.up.railway.app/support` | Public contact page with `info@ai4l.com.au`. |
| User data deletion: **Data deletion instructions URL** | `https://crm-ai4l-production.up.railway.app/data-deletion` | Choose the instructions URL option, not a callback option. |
| Facebook Login for Business: **Valid OAuth Redirect URIs** | `https://crm-ai4l-production.up.railway.app/api/social/oauth/meta/callback` | Exact Railway CRM callback for both Facebook Pages and linked Instagram accounts. Also add the Vercel callback below if staff use that host. |
| Redirect URI Validator | `https://crm-ai4l-production.up.railway.app/api/social/oauth/meta/callback` | If Meta offers a validator, check the same exact URL. |
| Deauthorize Callback URL | Leave blank | There is no deauthorization webhook endpoint yet. Do not use the OAuth callback or deletion instructions page here. |
| Data Deletion Callback URL / Data Deletion Request URL | Leave blank | The app provides a public instructions URL. It has no endpoint for signed deletion requests. |
| Webhooks Callback URL | Leave blank | The current integration does not subscribe to Meta webhooks. |
| JavaScript SDK allowed domains | Leave blank | The integration uses a server-side OAuth flow, not Meta's browser SDK. |

If the Meta dashboard offers both *Data deletion instructions URL* and *Data deletion callback URL*, select the first. If a dashboard field makes a callback mandatory for a selected use case, that use case needs a real signed-request endpoint and deletion workflow before it can be configured safely.

If staff also connect social accounts from the Vercel CRM, register **both** `crm-ai4-l.vercel.app` in App Domains and `https://crm-ai4-l.vercel.app/api/social/oauth/meta/callback` in Valid OAuth Redirect URIs. The policy, terms, support, and deletion fields need only one public URL each; use the Railway URLs above. The Content Engine API at `https://contentengineapi-production.up.railway.app` is a server-to-server service. Do not enter its domain in App Domains or OAuth redirect fields.

## Login settings

| Setting | Value |
| --- | --- |
| Client OAuth Login | On |
| Web OAuth Login | On |
| Enforce HTTPS | On |
| Valid OAuth Redirect URIs | The exact URL in the table above |
| Embedded Browser OAuth Login | Off, unless another client is added |

The Meta authorization flow currently requests `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, and `instagram_content_publish`. Request access to the permissions required for the features that will be released; availability may depend on Meta app review. Configure `META_APP_ID`, `META_APP_SECRET`, and, if using Facebook Login for Business, `META_LOGIN_CONFIG_ID` in the Content Engine API on Railway. When `META_LOGIN_CONFIG_ID` is set, select the needed permissions in that Meta login configuration: the code omits the `scope` parameter in this mode. Keep the CRM's `NEXT_PUBLIC_APP_URL` and the engine's `CRM_BASE_URL` pointed at the same chosen CRM origin; both currently point to the Railway CRM in Railway production.

## Publication checklist

The public pages identify Ai4l as the operator in Australia and use `info@ai4l.com.au` for privacy and deletion requests, as supplied by the business owner. Confirm the privacy, terms, and deletion text with the business owner. Open all four public pages in a private browser session to confirm they are readable without signing in before entering their URLs in Meta.
