/**
 * CALLOUT — Cloudflare Worker security boundary
 * --------------------------------------------------------------
 * The browser is untrusted. It may keep display state, but it never
 * decides who is paid, who is Pro, or how many scans remain.
 *
 * Required bindings:
 *   [vars]
 *     APP_ORIGIN = "https://callout-ai.com"
 *     STRIPE_PRICE_SCAN = your real Full Body Scan Stripe Price ID
 *     STRIPE_PRICE_PRO = your real CALLOUT Pro monthly Stripe Price ID
 *     STRIPE_PRICE_LIFETIME = your real Lifetime Stripe Price ID
 *     ANTHROPIC_MODEL = "claude-sonnet-5"  # optional override; default below.
 *       NOTE: claude-3-5-sonnet-20241022 was RETIRED by Anthropic on
 *       2025-10-28 and now returns 404. If this var is still set to it in the
 *       Cloudflare dashboard, delete the var or set a current model.
 *
 *     EMAIL_FROM = "CALLOUT <access@callout-ai.com>"  # sender for access-code emails
 *     ALLOW_LEGACY_TOKEN_ISSUE = "1"  # TEMPORARY: keeps the old direct
 *       issue-token-by-email path alive until RESEND_API_KEY is configured.
 *       Remove this var once access-code emails work — with it set, anyone
 *       who knows a buyer's email can mint their access token.
 *
 *   secrets:
 *     STRIPE_SECRET_KEY
 *     STRIPE_WEBHOOK_SECRET
 *     TOKEN_SECRET
 *     ANTHROPIC_API_KEY
 *     RESEND_API_KEY      # resend.com API key for access-code emails
 *     TURNSTILE_SECRET    # Cloudflare Turnstile secret; when set, anonymous
 *                         # (free) scans must present a valid Turnstile token
 *
 *   [[kv_namespaces]]
 *     binding = "ENTITLEMENTS"
 */

const TOKEN_TTL_SECONDS = 15 * 60;
const FREE_SCANS = 1;
const FREE_COUNTER_TTL = 60 * 60 * 24 * 30;
const MAX_JSON_BYTES = 7 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024;
// Caps worst-case per-account model spend below the Pro subscription price.
// Quoted in three places in index.html (pricing row, terms, progress card) —
// change them together.
const PRO_DAILY_SCAN_CAP = 20;
const API_DAILY_IP_CAP = 120;
const TOKEN_ISSUE_IP_DAILY_CAP = 30;
const OTP_TTL_SECONDS = 15 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_EMAIL_DAILY_CAP = 5;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const HISTORY_MAX_ENTRIES = 100;
const SUBSCRIBE_IP_DAILY_CAP = 20;
const SUBSCRIBE_EMAIL_DAILY_CAP = 3;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_REGIONS = new Set(['front', 'back', 'legs', 'arms_side']);
const MUSCLE_KEYS = ['shoulders', 'chest', 'arms', 'abs', 'back', 'traps', 'quads', 'hamstrings', 'glutes', 'calves', 'conditioning'];
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const REFUSAL_REASONS = new Set(['explicit', 'unclear_subject', 'non_human', 'unclear_view', 'scan_failed']);
const IMPROVE_DAILY_CAP = 6;
const IMPROVE_GOALS = new Set(['gain', 'lean', 'recomp']);
const IMPROVE_SET_KEYS = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'abs', 'quads', 'hamstrings', 'glutes', 'calves'];
const IMPROVE_REFUSALS = new Set(['unsafe_request', 'insufficient_input', 'report_failed']);

// What each requested view can honestly show, plus the structural cues that read
// true mass from that angle. Muscles outside a view's list are dropped
// server-side: a front photo cannot see a back, and a hallucinated back score
// silently raises the capped overall grade in the frontend.
const VIEW_SPEC = {
  front: {
    label: 'front view, subject facing the camera',
    muscles: ['shoulders', 'chest', 'arms', 'abs', 'traps', 'quads', 'calves', 'conditioning'],
    cues: 'Read clavicle-to-delt width and the outer sweep of the side delts, upper-chest shelf and the line where the pec meets the delt, biceps and forearm girth relative to elbow and wrist, abdominal wall thickness, and — only if the legs are in frame — quad sweep and calf girth. Do not score back, hamstrings, or glutes from this view.'
  },
  back: {
    label: 'back view, subject facing away from the camera',
    muscles: ['back', 'traps', 'shoulders', 'arms', 'glutes', 'hamstrings', 'calves', 'conditioning'],
    cues: 'Read lat width at the insertion and how far the lats flare from the waist, mid-back and rhomboid thickness, upper-trap mass and lower-trap detail, rear-delt roundness, triceps mass from behind, and — only if in frame — glute and hamstring development and calf girth. Do not score chest or abs from this view.'
  },
  legs: {
    label: 'legs view, lower body in frame',
    muscles: ['quads', 'hamstrings', 'glutes', 'calves', 'conditioning'],
    cues: 'Read quad sweep (outer vastus lateralis) and teardrop above the knee, hamstring thickness in profile, glute fullness, and calf girth relative to the ankle plus where the calf belly inserts. Do not score upper-body muscles from this view.'
  },
  arms_side: {
    label: 'arms or side view, best read on the arms and side delts',
    muscles: ['arms', 'shoulders', 'chest', 'traps', 'conditioning'],
    cues: 'Read biceps peak and belly length, triceps horseshoe and lateral head, forearm-to-wrist girth ratio, side-delt cap projection, and chest thickness in profile. Do not score back, abs, or legs from this view.'
  }
};

// The tier is derived from supported muscle scores, never used to move them.
// Bands mirror scoreToGrade() in the frontend
// (S>=90, A>=75, B>=61, C>=40, D>=25, E<25) — change them together.
const TIER_BANDS = {
  elite: [90, 100],
  advanced: [75, 89],
  experienced: [61, 74],
  developing: [40, 60],
  beginner: [25, 39],
  untrained: [0, 24]
};
const SCORING_VERSION = 'mass-calibration-v6-2026-09-22';
const MASS_QUALITY_VALUES = new Set(['clear', 'limited', 'unusable']);

// Public counter baselines: scans delivered and individual physiques graded
// before live counting started (owner-verified figures, 2026-08-14). Live KV
// counters add to these, so the published number is never an over-claim.
const STATS_BASELINE_SCANS = 1050;
const STATS_BASELINE_PEOPLE = 800;
const STATS_SEEN_TTL = 60 * 60 * 24 * 365;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/stripe/webhook') {
      return handleWebhook(req, env);
    }

    const cors = corsHeaders(req, env);
    if (!cors.allowed) return errorResponse(400, 'bad_request', cors.headers, { reason: 'origin_not_allowed' });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
    if (req.method !== 'POST') return errorResponse(400, 'bad_request', cors.headers);

    let body;
    try {
      body = await readJsonBody(req, MAX_JSON_BYTES);
    } catch (err) {
      return errorResponse(400, 'bad_request', cors.headers, { reason: err?.message === 'body_too_large' ? 'body_too_large' : 'bad_json' });
    }

    // Public counters are read on every landing-page view, so they are served
    // before the per-IP action budget — otherwise ordinary browsing would burn
    // the same allowance that scans and sign-ins need. Two KV reads, no writes,
    // nothing account-specific: cheap enough to leave uncapped.
    if (body.action === 'stats') {
      return publicStats(env, cors.headers);
    }

    // One shared per-IP daily budget for every JSON action. Previously only
    // the grading path was capped, leaving issue_token / verify_payment open
    // to unlimited enumeration and Stripe-API amplification.
    const ipBucket = 'ip:' + hashish(clientIp(req));
    if (await limitExceeded(env, 'rl:api:' + todayKey() + ':' + ipBucket, API_DAILY_IP_CAP, secondsUntilTomorrow())) {
      return errorResponse(429, 'rate_limited', cors.headers, { retry_after_seconds: secondsUntilTomorrow() });
    }

    try {
      switch (body.action) {
        case 'verify_payment':
          return verifyPayment(body, env, cors.headers);
        case 'issue_token':
          return issueTokenForEmail(req, body, env, cors.headers);
        case 'request_code':
          return requestAccessCode(req, body, env, cors.headers);
        case 'redeem_code':
          return redeemAccessCode(req, body, env, cors.headers);
        case 'refresh_token':
          return refreshAccessToken(req, env, cors.headers);
        case 'get_history':
          return getHistory(req, env, cors.headers);
        case 'improve':
          return improveRequest(req, body, env, cors.headers);
        case 'get_improve':
          return getImprove(req, env, cors.headers);
        case 'dev_access':
          return devAccess(req, env, cors.headers);
        case 'dev_grade':
          return gradeRequest(req, body, env, cors.headers);
        case 'check_subscription':
          return checkSubscription(req, body, env, cors.headers);
        case 'subscribe':
          return subscribeEmail(req, body, env, cors.headers);
        default:
          return gradeRequest(req, body, env, cors.headers);
      }
    } catch (err) {
      console.error('CALLOUT worker error', safeErrorLog(err));
      return errorResponse(500, 'server_error', cors.headers);
    }
  }
};

/* ============================================================
 * Tokens
 * ============================================================ */
async function hmacKey(secret) {
  if (!secret) throw new Error('TOKEN_SECRET missing');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signToken(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + b64url(new Uint8Array(sig));
}

async function verifySignedToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  let sigBytes;
  try {
    sigBytes = b64urlToBytes(sig);
  } catch {
    return null;
  }

  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
  if (!ok) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }

  if (!claims.email || !claims.exp || claims.exp <= nowSec()) return null;
  return claims;
}

async function verifyToken(token, secret) {
  const claims = await verifySignedToken(token, secret);
  if (!claims) return null;
  // Tokens minted before typ existed carry no typ and are access tokens.
  if (claims.typ && claims.typ !== 'access') return null;
  if (!claims.tier || !['scan', 'pro', 'lifetime', 'dev'].includes(claims.tier)) return null;
  return claims;
}

async function verifyRefreshToken(token, secret) {
  const claims = await verifySignedToken(token, secret);
  if (!claims || claims.typ !== 'refresh') return null;
  return claims;
}

async function issueToken(env, email, tier) {
  return signToken({
    iss: 'callout-worker',
    aud: 'callout-app',
    typ: 'access',
    jti: crypto.randomUUID(),
    email: normalizeEmail(email),
    tier,
    iat: nowSec(),
    exp: nowSec() + TOKEN_TTL_SECONDS
  }, env.TOKEN_SECRET);
}

// Long-lived device token, only ever issued after real proof of ownership:
// a verified Stripe checkout session or a redeemed email code. It carries no
// tier — the live entitlement is re-checked every time it's exchanged.
async function issueRefreshToken(env, email) {
  return signToken({
    iss: 'callout-worker',
    aud: 'callout-app',
    typ: 'refresh',
    jti: crypto.randomUUID(),
    email: normalizeEmail(email),
    iat: nowSec(),
    exp: nowSec() + REFRESH_TTL_SECONDS
  }, env.TOKEN_SECRET);
}

function bearerToken(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/* ============================================================
 * Payment confirmation
 * ============================================================ */
async function verifyPayment(body, env, cors) {
  const id = String(body.session_id || '').trim();
  if (!id) {
    return json({
      verified: false,
      error: 'bad_request',
      reason: 'missing_session',
      message: 'Stripe did not return a checkout session. Access was not granted.'
    }, 400, cors);
  }

  let session;
  try {
    session = await retrieveCheckoutSession(env, id);
  } catch {
    return json({
      verified: false,
      error: 'server_error',
      reason: 'stripe_verification_failed',
      message: 'We could not confirm your payment with Stripe yet. Access has not been granted. If you were charged, refresh in a moment or contact support@callout-ai.com.'
    }, 500, cors);
  }

  if (session.payment_status !== 'paid') {
    return json({
      verified: false,
      error: 'payment_required',
      reason: 'payment_not_paid',
      message: 'Stripe has not marked this checkout as paid, so access has not been granted.'
    }, 402, cors);
  }

  const email = emailFromCheckoutSession(session);
  const resolved = resolveTierFromStripeObject(session, env);
  if (!email || !resolved.ok) {
    return json({
      verified: false,
      error: 'payment_required',
      reason: resolved.error || 'checkout_not_recognised',
      message: 'Payment was found, but it did not match a configured CALLOUT product. Access has not been granted. Contact support@callout-ai.com if you were charged.'
    }, 402, cors);
  }

  // Useful for success redirects. The webhook remains the durable source of truth
  // because it will still run even if the customer closes the browser.
  await persistEntitlement(env, email, resolved.tier, session, { source: 'verify_payment' });
  // Paid access must survive a mailing-service outage; the checkout webhook
  // retries contact delivery independently until it succeeds.
  try { await syncSignupContact(env, email); } catch {}
  const token = await issueToken(env, email, resolved.tier);
  // A verified checkout session is proof of ownership, so this device also
  // gets a long-lived refresh token — no email code needed on the buying device.
  const refresh = await issueRefreshToken(env, email);
  return json({
    verified: true,
    source: 'stripe_api',
    email,
    tier: resolved.tier,
    token,
    expires_in: TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    refresh_expires_in: REFRESH_TTL_SECONDS
  }, 200, cors);
}

async function issueTokenForEmail(req, body, env, cors) {
  const email = normalizeEmail(body.email);
  if (!email) return json({ active: false, error: 'bad_request', reason: 'missing_email' }, 400, cors);

  // Magic-link mode (the default): access tokens are never handed out on
  // email knowledge alone. The client is told a code is required; it sends
  // action 'request_code' explicitly (so silent background refreshes never
  // trigger emails), then 'redeem_code'.
  if (env.ALLOW_LEGACY_TOKEN_ISSUE !== '1') {
    return json({ active: false, code_required: true }, 200, cors);
  }

  // Legacy direct issuance — throttled hard while it remains enabled.
  const ipBucket = 'ip:' + hashish(clientIp(req));
  if (await limitExceeded(env, 'rl:tok:' + todayKey() + ':' + ipBucket, TOKEN_ISSUE_IP_DAILY_CAP, secondsUntilTomorrow())) {
    return json({ active: false, error: 'rate_limited' }, 429, cors);
  }

  const ent = await readEntitlement(env, email);
  if (!ent || !entitlementActive(ent)) return json({ active: false }, 200, cors);

  const token = await issueToken(env, email, ent.tier);
  return json({ active: true, email, tier: ent.tier, token, expires_in: TOKEN_TTL_SECONDS }, 200, cors);
}

/* ============================================================
 * Magic-link access codes
 * ============================================================ */
async function requestAccessCode(req, body, env, cors) {
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) return json({ ok: false, error: 'bad_request' }, 400, cors);

  const ttl = secondsUntilTomorrow();
  const ipBucket = 'ip:' + hashish(clientIp(req));
  const ipLimited = await limitExceeded(env, 'rl:tok:' + todayKey() + ':' + ipBucket, TOKEN_ISSUE_IP_DAILY_CAP, ttl);
  const emailLimited = await limitExceeded(env, 'rl:otp:' + todayKey() + ':email:' + hashish(email), OTP_EMAIL_DAILY_CAP, ttl);
  if (ipLimited || emailLimited) return json({ ok: false, error: 'rate_limited' }, 429, cors);

  // Identical response whether or not a purchase exists — no oracle for
  // probing which emails have paid accounts.
  const generic = { ok: true, code_required: true };

  const ent = await readEntitlement(env, email);
  if ((!ent || !entitlementActive(ent)) && !hasDevAccess(env, email)) return json(generic, 200, cors);

  if (!env.RESEND_API_KEY) {
    return json({
      ok: false,
      error: 'email_not_configured',
      message: 'Access emails are not set up yet. Contact support@callout-ai.com to restore access.'
    }, 503, cors);
  }

  const code = randomCode();
  await env.ENTITLEMENTS.put(
    'otp:' + email,
    JSON.stringify({ code, attempts: 0, created: nowSec() }),
    { expirationTtl: OTP_TTL_SECONDS }
  );

  const sent = await sendAccessCodeEmail(env, email, code);
  if (!sent) return json({ ok: false, error: 'email_send_failed' }, 502, cors);
  return json(generic, 200, cors);
}

async function redeemAccessCode(req, body, env, cors) {
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'bad_request' }, 400, cors);
  }

  const raw = await env.ENTITLEMENTS.get('otp:' + email);
  if (!raw) return json({ ok: false, error: 'code_invalid' }, 401, cors);

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'code_invalid' }, 401, cors);
  }

  if ((rec.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await env.ENTITLEMENTS.delete('otp:' + email);
    return json({ ok: false, error: 'code_invalid' }, 401, cors);
  }

  if (!timingSafeEqual(String(rec.code || ''), code)) {
    rec.attempts = (rec.attempts || 0) + 1;
    const remaining = Math.max(60, (rec.created || nowSec()) + OTP_TTL_SECONDS - nowSec());
    await env.ENTITLEMENTS.put('otp:' + email, JSON.stringify(rec), { expirationTtl: remaining });
    return json({ ok: false, error: 'code_invalid' }, 401, cors);
  }

  await env.ENTITLEMENTS.delete('otp:' + email);

  const ent = await readEntitlement(env, email);
  if ((!ent || !entitlementActive(ent)) && !hasDevAccess(env, email)) return json({ active: false }, 200, cors);

  const token = await issueToken(env, email, (ent && entitlementActive(ent) ? ent.tier : 'dev'));
  const refresh = await issueRefreshToken(env, email);
  return json({
    active: true,
    email,
    tier: (ent && entitlementActive(ent) ? ent.tier : 'dev'),
    token,
    expires_in: TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    refresh_expires_in: REFRESH_TTL_SECONDS
  }, 200, cors);
}

async function refreshAccessToken(req, env, cors) {
  const claims = await verifyRefreshToken(bearerToken(req), env.TOKEN_SECRET);
  if (!claims) return json({ active: false, error: 'invalid_token' }, 401, cors);

  const ent = await readEntitlement(env, claims.email);
  if ((!ent || !entitlementActive(ent)) && !hasDevAccess(env, claims.email)) return json({ active: false }, 200, cors);

  const token = await issueToken(env, claims.email, (ent && entitlementActive(ent) ? ent.tier : 'dev'));
  return json({ active: true, email: claims.email, tier: (ent && entitlementActive(ent) ? ent.tier : 'dev'), token, expires_in: TOKEN_TTL_SECONDS }, 200, cors);
}

function randomCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

function accessCodeEmailHtml(code, link) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef1f6;">
<div style="display:none;max-height:0;overflow:hidden;">Your sign-in code &mdash; expires in 15 minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:36px 14px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;">
<tr><td style="background:#05070B;border:1px solid #1B2A40;border-top:3px solid #2F80FF;border-radius:14px;padding:36px 32px 30px;text-align:center;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;color:#F4F8FF;letter-spacing:6px;">CALLOUT</div>
<div style="height:1px;background:#1B2A40;margin:26px 0;"></div>
<div style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#2F80FF;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:15px 38px;border-radius:10px;">Sign in &mdash; one tap</a></div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#7F91A8;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px;">Or enter this code</div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:36px;font-weight:800;color:#5B9DFF;letter-spacing:9px;text-indent:9px;margin-bottom:16px;">${code}</div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#B9C7D9;">Expires in 15 minutes. Works once.</div>
<div style="height:1px;background:#1B2A40;margin:26px 0;"></div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#526278;">Didn&rsquo;t request this? Ignore this email &mdash; nobody can access your account without the code.</div>
</td></tr>
<tr><td style="padding:16px 8px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#7F91A8;letter-spacing:2px;">CALLOUT-AI.COM</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendAccessCodeEmail(env, email, code) {
  const signinLink = (env.APP_ORIGIN || 'https://callout-ai.com') + '/?rc=' + code + '&re=' + encodeURIComponent(email);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'CALLOUT <access@callout-ai.com>',
        to: [email],
        subject: 'Your CALLOUT access code: ' + code,
        html: accessCodeEmailHtml(code, signinLink),
        text: 'Your CALLOUT sign-in code is ' + code + '.\n\nOne-tap sign-in: ' + signinLink + '\n\nIt expires in 15 minutes and works once. If you did not request it, you can ignore this email — nobody can access your account without it.'
      })
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function checkSubscription(req, body, env, cors) {
  const token = bearerToken(req);
  if (!token) return json({ active: false, error: 'invalid_token' }, 401, cors);
  const claims = await verifyToken(token, env.TOKEN_SECRET);
  if (!claims) return json({ active: false, error: 'invalid_token' }, 401, cors);
  const email = claims.email;

  const ent = await readEntitlement(env, email);
  const active = !!ent && entitlementActive(ent);
  return json({ active, tier: active ? ent.tier : null }, 200, cors);
}

/* ============================================================
 * Grading request
 * ============================================================ */
function hasDevAccess(env, email) {
  // Keep the two owner accounts built in so an older dashboard variable cannot
  // silently remove the newly added owner. The variable may add/revoke other
  // addresses, but both owner identities always remain authorized.
  const allowlist = 'nicholasdrew59@gmail.com,nicholasdrew62@gmail.com,' +
    (env.DEV_ACCESS_EMAILS === undefined ? '' : String(env.DEV_ACCESS_EMAILS));
  return allowlist.split(',').map(normalizeEmail).filter(Boolean).includes(normalizeEmail(email));
}
async function devAccess(req, env, cors) {
  const claims = await verifyToken(bearerToken(req), env.TOKEN_SECRET);
  if (!claims) return errorResponse(401, 'invalid_token', cors);
  return json({ dev_access: hasDevAccess(env, claims.email) }, 200, cors);
}

function validateAdultDob(value, today = new Date()) {
  const dob = typeof value === 'string' ? value.trim() : '';
  if (!dob) return { ok: false, reason: 'dob_required' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return { ok: false, reason: 'invalid_dob' };

  const [year, month, day] = dob.split('-').map(Number);
  const born = new Date(Date.UTC(year, month - 1, day));
  if (born.getUTCFullYear() !== year || born.getUTCMonth() !== month - 1 || born.getUTCDate() !== day) {
    return { ok: false, reason: 'invalid_dob' };
  }

  const currentYear = today.getUTCFullYear();
  const currentMonth = today.getUTCMonth() + 1;
  const currentDay = today.getUTCDate();
  if (year > currentYear || (year === currentYear && (month > currentMonth || (month === currentMonth && day > currentDay)))) {
    return { ok: false, reason: 'invalid_dob' };
  }

  let age = currentYear - year;
  if (currentMonth < month || (currentMonth === month && currentDay < day)) age--;
  return age >= 18 ? { ok: true } : { ok: false, reason: 'underage' };
}

async function gradeRequest(req, body, env, cors) {
  const dev = body.action === 'dev_grade';
  if (dev) {
    const identity = await verifyToken(bearerToken(req), env.TOKEN_SECRET);
    if (!identity) return errorResponse(401, 'invalid_token', cors);
    if (!hasDevAccess(env, identity.email)) return errorResponse(403, 'dev_access_denied', cors);
  }
  if (!dev) {
    const adult = validateAdultDob(body.dob);
    if (!adult.ok) {
      const status = adult.reason === 'underage' ? 403 : 400;
      return errorResponse(status, 'age_requirement_failed', cors, { reason: adult.reason });
    }
  }
  const region = String(body.region || '');
  const image = String(body.image || '');
  const mediaType = String(body.media_type || 'image/jpeg');
  const normalizedImage = body.normalized_image == null ? null : body.normalized_image;

  if (!ALLOWED_REGIONS.has(region)) {
    return errorResponse(400, 'bad_request', cors, { reason: 'bad_region' });
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return errorResponse(400, 'bad_request', cors, { reason: 'bad_media_type' });
  }
  if (!isValidBase64Image(image)) {
    return errorResponse(400, 'bad_request', cors, { reason: 'bad_image' });
  }
  if (normalizedImage !== null && (!isValidBase64Image(normalizedImage) ||
      image.length + normalizedImage.length > MAX_IMAGE_BASE64_CHARS)) {
    return errorResponse(400, 'bad_request', cors, { reason: 'bad_image' });
  }

  const token = bearerToken(req);
  let claims = null;
  if (token) {
    claims = await verifyToken(token, env.TOKEN_SECRET);
    if (!claims) return errorResponse(401, 'invalid_token', cors);
  }

  // The shared per-IP daily cap was already charged in the fetch handler.
  const ipBucket = 'ip:' + hashish(clientIp(req));

  const email = normalizeEmail(claims?.email || body.email);
  let freeKeys = null;

  if (claims) {
    const entitlement = await validateScanEntitlement(env, claims, region);
    if (!dev && !entitlement.ok) {
      return errorResponse(402, 'payment_required', cors, { reason: entitlement.reason, locked: true });
    }
    const paidLimit = await checkPaidRateLimits(env, dev ? { ...claims, tier: 'dev' } : claims, ipBucket);
    if (!paidLimit.ok) {
      return errorResponse(429, 'rate_limited', cors, { reason: paidLimit.reason, retry_after_seconds: paidLimit.retry_after_seconds });
    }
  } else {
    // Anonymous scans are the abuse surface: when Turnstile is configured,
    // require a valid bot-check token before any free model spend.
    if (env.TURNSTILE_SECRET) {
      const human = await verifyTurnstile(env, String(body.ts_token || ''), clientIp(req));
      if (!human) return errorResponse(403, 'bot_check_failed', cors);
    }
    const free = await consumeFreeScan(env, body, req);
    if (free.blocked) return errorResponse(402, 'payment_required', cors, { reason: 'free_used', locked: true });
    freeKeys = free.keys;
  }

  let result;
  try {
    result = await gradePhoto(env, region, image, mediaType, normalizedImage);
  } catch (err) {
    // Model/provider failure must not eat the user's allowance.
    if (freeKeys) await refundFreeScan(env, freeKeys);
    throw err;
  }

  if (result.refused) {
    // A refused photo (blurry, cropped, ineligible) is not a delivered scan:
    // refund the free counter and never mark a paid scan-tier region as used.
    if (freeKeys) await refundFreeScan(env, freeKeys);
    return json(result, 200, cors);
  }

  // Preserve supported mass scores; keep the existing conditioning check.
  result = calibrateResult(result);

  // Consume the scan-tier region only after a successful, delivered grade.
  if (!dev && claims && claims.tier === 'scan') {
    await markScanViewUsed(env, email, region);
  }

  // Public counters. Pass every handle we hold for this person so the anonymous
  // free scan and the later signed-in one are recognised as the same visitor.
  // Never let a counter write break a delivered scan.
  try {
    if (!dev) await recordScanStats(env, ['dev:' + deviceKey(req), email ? 'em:' + email : '']);
  } catch {}

  // Paid scans are saved to the account's history. Never let a history
  // write failure break a delivered scan.
  if (claims && !dev) {
    try { await appendHistory(env, email, region, result); } catch {}
  }

  const response = claims ? paidView(result, claims.tier) : freeView(result);
  response.entitlement = claims ? { tier: claims.tier } : { tier: null };
  return json(response, 200, cors);
}

async function validateScanEntitlement(env, claims, region) {
  const ent = await readEntitlement(env, claims.email);
  if (!ent || !entitlementActive(ent)) return { ok: false, reason: 'entitlement_inactive' };
  if (ent.tier !== claims.tier) return { ok: false, reason: 'token_stale' };

  if (ent.tier === 'pro' || ent.tier === 'lifetime') return { ok: true };

  if (ent.tier === 'scan') {
    const used = ent.scan_views || {};
    if (!used[region] && Object.keys(used).length >= ALLOWED_REGIONS.size) {
      return { ok: false, reason: 'scan_limit_used' };
    }
    if (used[region]) return { ok: false, reason: 'rescan_requires_pro' };
    return { ok: true };
  }

  return { ok: false, reason: 'entitlement_invalid' };
}

async function checkPaidRateLimits(env, claims, ipBucket) {
  // Dev Access is owner-only and used for product testing; keep it available
  // without consuming the customer-facing paid scan allowance.
  if (claims.tier === 'scan' || claims.tier === 'dev') return { ok: true };

  const ttl = secondsUntilTomorrow();
  const suffixes = [
    'email:' + hashish(claims.email),
    'token:' + hashish(claims.jti || claims.email + ':' + claims.iat),
    ipBucket
  ];

  for (const suffix of suffixes) {
    const limited = await limitExceeded(env, 'rl:paid:' + todayKey() + ':' + suffix, PRO_DAILY_SCAN_CAP, ttl);
    if (limited) return { ok: false, reason: 'daily_scan_cap', retry_after_seconds: ttl };
  }
  return { ok: true };
}

// Evidence and the derived tier are internal diagnostics, not product copy.
function stripInternal(result) {
  const out = { ...result };
  delete out.photo_read;
  delete out.tier;
  delete out.mass_evidence;
  return out;
}

function freeView(result) {
  const out = stripInternal(result);
  delete out.verdict;
  delete out.bodyfat_range;
  delete out.bodyfat_estimate;
  delete out.percentile;
  delete out.overall;
  delete out.weakest_visible_area;
  delete out.strongest_visible_area;
  delete out.next_focus;
  out.scoring_version = SCORING_VERSION;
  out.free = true;
  return out;
}

function paidView(result, tier) {
  return { ...stripInternal(result), scoring_version: SCORING_VERSION, free: false, paid_tier: tier };
}

/* ============================================================
 * Stripe webhooks
 * ============================================================ */
async function handleWebhook(req, env) {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  const sig = req.headers.get('stripe-signature') || '';
  let raw;
  try {
    raw = await readTextBody(req, MAX_WEBHOOK_BYTES);
  } catch {
    return new Response('bad_request', { status: 400 });
  }
  const ok = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response('bad_signature', { status: 400 });

  const event = JSON.parse(raw);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutSessionCompleted(env, event.data.object);
        break;
      case 'invoice.paid':
        await onInvoicePaid(env, event.data.object);
        break;
      case 'invoice.payment_failed':
        await onInvoicePaymentFailed(env, event.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(env, event.data.object);
        break;
      case 'customer.subscription.updated':
        await onSubscriptionUpdated(env, event.data.object);
        break;
      case 'charge.refunded':
        await onChargeRefunded(env, event.data.object);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('Stripe webhook handling failed', event.type, err && (err.stack || err.message || err));
    return new Response('webhook_handler_failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}

async function onCheckoutSessionCompleted(env, sessionObject) {
  const session = await retrieveCheckoutSession(env, sessionObject.id);
  if (session.payment_status !== 'paid') return;

  const email = emailFromCheckoutSession(session);
  const resolved = resolveTierFromStripeObject(session, env);
  if (!email || !resolved.ok) {
    console.error('checkout.session.completed ignored: unresolved email or tier', session.id, resolved.error);
    return;
  }

  await persistEntitlement(env, email, resolved.tier, session, { source: 'checkout.session.completed' });
  await syncSignupContact(env, email);
}

async function onInvoicePaid(env, invoiceObject) {
  const invoice = await retrieveInvoice(env, invoiceObject.id);
  const resolved = resolveTierFromStripeObject(invoice, env);
  if (!resolved.ok || resolved.tier !== 'pro') {
    console.error('invoice.paid ignored: invoice is not configured Pro', invoice.id, resolved.error);
    return;
  }

  const subscriptionId = idOf(invoice.subscription);
  const subscription = subscriptionId ? await retrieveSubscription(env, subscriptionId) : null;
  const customerId = idOf(invoice.customer) || idOf(subscription?.customer);
  const email = await emailForStripeCustomer(env, customerId, invoice.customer_email);

  if (!email) {
    console.error('invoice.paid ignored: no email for customer', customerId || 'unknown');
    return;
  }

  await persistEntitlement(env, email, 'pro', { ...invoice, subscription }, { source: 'invoice.paid' });
}

async function onInvoicePaymentFailed(env, invoiceObject) {
  const invoice = await retrieveInvoice(env, invoiceObject.id);
  const subscriptionId = idOf(invoice.subscription);
  const customerId = idOf(invoice.customer);
  const email = await emailForStripeCustomer(env, customerId, invoice.customer_email);
  if (!email) return;
  const ent = await readEntitlement(env, email);
  if (!ent || ent.tier !== 'pro') return;
  if (subscriptionId && ent.stripe_subscription && ent.stripe_subscription !== subscriptionId) return;
  await revokeEntitlement(env, email, {
    reason: 'invoice_payment_failed',
    stripe_customer: customerId,
    stripe_subscription: subscriptionId,
    stripe_invoice: invoice.id
  });
}

async function onSubscriptionDeleted(env, sub) {
  const email = await emailForStripeCustomer(env, idOf(sub.customer));
  if (!email) return;
  const ent = await readEntitlement(env, email);
  if (!ent || ent.tier !== 'pro') return;
  if (ent.stripe_subscription && ent.stripe_subscription !== sub.id) return;
  await revokeEntitlement(env, email, {
    reason: 'subscription_deleted',
    stripe_customer: idOf(sub.customer),
    stripe_subscription: sub.id
  });
}

async function onSubscriptionUpdated(env, sub) {
  const email = await emailForStripeCustomer(env, idOf(sub.customer));
  if (!email) return;

  const ent = await readEntitlement(env, email);
  if (!ent || ent.tier !== 'pro') return;

  const activeStatuses = new Set(['active', 'trialing']);
  if (!activeStatuses.has(sub.status)) {
    await revokeEntitlement(env, email, {
      reason: 'subscription_' + sub.status,
      stripe_customer: idOf(sub.customer),
      stripe_subscription: sub.id
    });
    return;
  }

  ent.status = 'active';
  ent.stripe_customer = idOf(sub.customer) || ent.stripe_customer || null;
  ent.stripe_subscription = sub.id;
  ent.subscription_status = sub.status;
  ent.current_period_end = subscriptionPeriodEnd(sub, env) || ent.current_period_end || null;
  ent.cancel_at_period_end = !!sub.cancel_at_period_end;
  ent.updated = nowSec();
  await writeEntitlement(env, email, ent);
}

async function onChargeRefunded(env, charge) {
  if (!charge.refunded && Number(charge.amount_refunded || 0) < Number(charge.amount || 0)) return;

  // Basil webhook payloads removed charge.invoice. Retrieve our pinned shape
  // before resolving a subscription refund to its invoice and entitlement.
  if (!charge.invoice && charge.id) {
    charge = await stripeGet(env, '/v1/charges/' + encodeURIComponent(charge.id));
  }

  const customerId = idOf(charge.customer);
  const paymentIntentId = idOf(charge.payment_intent);
  let refundedTier = null;
  let subscriptionId = null;

  if (charge.invoice) {
    const invoice = await retrieveInvoice(env, idOf(charge.invoice));
    const resolved = resolveTierFromStripeObject(invoice, env);
    refundedTier = resolved.ok ? resolved.tier : null;
    subscriptionId = idOf(invoice.subscription);
  }

  let email = await emailForStripeCustomer(env, customerId, charge.billing_details?.email);

  if (!email && paymentIntentId) {
    email = await env.ENTITLEMENTS.get('pi:' + paymentIntentId);
  }

  if (!email) return;
  const ent = await readEntitlement(env, email);
  if (!ent) return;

  if (refundedTier && ent.tier !== refundedTier) return;
  if (subscriptionId && ent.stripe_subscription !== subscriptionId) return;
  if (!refundedTier && paymentIntentId && ent.stripe_payment_intent !== paymentIntentId) return;

  await revokeEntitlement(env, email, {
    reason: 'charge_refunded',
    stripe_customer: customerId,
    stripe_charge: charge.id,
    stripe_payment_intent: paymentIntentId,
    stripe_subscription: subscriptionId,
    refunded_tier: refundedTier
  });
}

async function verifyStripeSignature(payload, header, secret) {
  if (!secret || !header) return false;
  const pairs = header.split(',').map(part => part.split('='));
  const t = pairs.find(([k]) => k === 't')?.[1];
  const signatures = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || signatures.length === 0) return false;

  const timestamp = Number(t);
  if (!Number.isFinite(timestamp) || Math.abs(nowSec() - timestamp) > 300) return false;

  const key = await hmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + payload))
  );
  const hex = [...expected].map(b => b.toString(16).padStart(2, '0')).join('');
  return signatures.some(v => timingSafeEqual(hex, v));
}

async function retrieveCheckoutSession(env, id) {
  return stripeGet(
    env,
    '/v1/checkout/sessions/' + encodeURIComponent(id) + '?expand[]=line_items&expand[]=subscription'
  );
}

async function retrieveInvoice(env, id) {
  return stripeGet(
    env,
    '/v1/invoices/' + encodeURIComponent(id) + '?expand[]=lines.data.price&expand[]=subscription'
  );
}

async function retrieveSubscription(env, id) {
  return stripeGet(env, '/v1/subscriptions/' + encodeURIComponent(id));
}

async function retrieveCustomer(env, id) {
  return stripeGet(env, '/v1/customers/' + encodeURIComponent(id));
}

async function stripeGet(env, path) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY missing');
  const r = await fetch('https://api.stripe.com' + path, {
    // Keep the retrieval shape stable independently of the account default.
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': '2024-06-20' }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe request failed: ' + r.status);
  return data;
}

/* ============================================================
 * Entitlements
 * ============================================================ */
async function persistEntitlement(env, email, tier, stripeObject, meta = {}) {
  email = normalizeEmail(email);
  if (!email || !tier) return;

  const existing = await readEntitlement(env, email);
  const subscription = typeof stripeObject?.subscription === 'object' ? stripeObject.subscription : null;
  const scanViews = existing?.scan_views && tier === 'scan' ? existing.scan_views : {};
  const customerId = idOf(stripeObject?.customer) || idOf(subscription?.customer) || existing?.stripe_customer || null;
  const subscriptionId = idOf(subscription?.id || stripeObject?.subscription) || existing?.stripe_subscription || null;
  const paymentIntentId = idOf(stripeObject?.payment_intent) || existing?.stripe_payment_intent || null;
  const resolved = resolveTierFromStripeObject(stripeObject, env);

  const rec = {
    email,
    tier: chooseEntitlementTier(existing?.tier, tier),
    status: 'active',
    created: existing?.created || nowSec(),
    updated: nowSec(),
    source: meta.source || existing?.source || null,
    stripe_customer: customerId,
    stripe_subscription: subscriptionId,
    stripe_checkout_session: stripeObject?.object === 'checkout.session' ? stripeObject.id : existing?.stripe_checkout_session || null,
    stripe_invoice: stripeObject?.object === 'invoice' ? stripeObject.id : existing?.stripe_invoice || null,
    stripe_payment_intent: paymentIntentId,
    stripe_price: resolved.priceId || existing?.stripe_price || null,
    stripe_metadata_tier: resolved.metadataTier || existing?.stripe_metadata_tier || null,
    subscription_status: subscription?.status || existing?.subscription_status || null,
    current_period_end: subscriptionPeriodEnd(subscription, env) || periodEndFromInvoice(stripeObject) || existing?.current_period_end || null,
    cancel_at_period_end: !!subscription?.cancel_at_period_end,
    scan_views: tier === 'scan' || existing?.tier === 'scan' ? scanViews : undefined
  };

  await writeEntitlement(env, email, rec);
  await persistStripeMappings(env, email, rec);
}

async function writeEntitlement(env, email, rec) {
  await env.ENTITLEMENTS.put('ent:' + normalizeEmail(email), JSON.stringify(rec));
}

async function persistStripeMappings(env, email, rec) {
  email = normalizeEmail(email);
  if (rec.stripe_customer) await env.ENTITLEMENTS.put('customer:' + rec.stripe_customer, email);
  if (rec.stripe_subscription) await env.ENTITLEMENTS.put('sub:' + rec.stripe_subscription, email);
  if (rec.stripe_payment_intent) await env.ENTITLEMENTS.put('pi:' + rec.stripe_payment_intent, email);
}

async function readEntitlement(env, email) {
  email = normalizeEmail(email);
  if (!email) return null;
  const v = await env.ENTITLEMENTS.get('ent:' + email);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function markScanViewUsed(env, email, region) {
  const ent = await readEntitlement(env, email);
  if (!ent || ent.tier !== 'scan') return;
  ent.scan_views = ent.scan_views || {};
  ent.scan_views[region] = nowSec();
  ent.updated = nowSec();
  await writeEntitlement(env, email, ent);
}

/* ============================================================
 * Scan history (paid accounts)
 * ============================================================ */
async function appendHistory(env, email, region, result) {
  email = normalizeEmail(email);
  if (!email) return;

  let list = [];
  try {
    list = JSON.parse((await env.ENTITLEMENTS.get('hist:' + email)) || '[]');
  } catch {}
  if (!Array.isArray(list)) list = [];

  const muscles = {};
  for (const [k, v] of Object.entries(result.muscles || {})) {
    if (v && Number.isFinite(v.score)) muscles[k] = v.score;
  }
  const vals = Object.values(muscles);
  const avg = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  const sizeKeys = Object.keys(muscles).filter(k => k !== 'conditioning');

  list.push({
    ts: nowSec(),
    region,
    score: avg,
    // Keep the legacy score for older history clients. Explicit components and
    // version make new mass readings inspectable without reinterpreting old ones.
    scoring_version: SCORING_VERSION,
    mass_score: sizeKeys.length ? Math.round(sizeKeys.reduce((s, k) => s + muscles[k], 0) / sizeKeys.length) : null,
    conditioning_score: muscles.conditioning ?? null,
    confidence: Object.fromEntries(Object.entries(result.muscles || {}).map(([k, v]) => [k, v.confidence])),
    mass_quality: Object.fromEntries(Object.entries(result.mass_evidence || {}).map(([k, v]) => [k, v.quality])),
    muscles,
    bodyfat_range: result.bodyfat_range || null,
    verdict: result.verdict || null
  });
  while (list.length > HISTORY_MAX_ENTRIES) list.shift();

  await env.ENTITLEMENTS.put('hist:' + email, JSON.stringify(list));
}

async function getHistory(req, env, cors) {
  const claims = await verifyToken(bearerToken(req), env.TOKEN_SECRET);
  if (!claims) return json({ error: 'invalid_token' }, 401, cors);

  const ent = await readEntitlement(env, claims.email);
  if (!ent || !entitlementActive(ent)) return json({ error: 'payment_required' }, 402, cors);

  let list = [];
  try {
    list = JSON.parse((await env.ENTITLEMENTS.get('hist:' + claims.email)) || '[]');
  } catch {}
  return json({ history: Array.isArray(list) ? list : [] }, 200, cors);
}

/* ============================================================
 * Public counters
 * ============================================================ */
// Two live counters behind the numbers shown on the landing page. KV has no
// atomic increment, so simultaneous scans can lose a tick — an undercount is
// the right way to be wrong for a public claim, and the displayed figure is
// floored and shown with a "+" anyway.
// A visitor is counted once. Identities are every handle we hold for them on
// this request — the device and, when known, the email. A new person is counted
// only when NONE of those has been seen before, and every identity is then
// marked. That is what stops a free anonymous scan and a later signed-in scan
// from the same browser counting as two people.
async function recordScanStats(env, identities) {
  const scans = parseInt((await env.ENTITLEMENTS.get('stats:scans')) || '0', 10);
  await env.ENTITLEMENTS.put('stats:scans', String(scans + 1));

  const keys = (identities || []).filter(Boolean).map(id => 'stats:seen:' + hashish(id));
  if (!keys.length) return;

  let known = false;
  for (const key of keys) {
    if (await env.ENTITLEMENTS.get(key)) { known = true; break; }
  }
  for (const key of keys) {
    await env.ENTITLEMENTS.put(key, '1', { expirationTtl: STATS_SEEN_TTL });
  }
  if (known) return;

  const people = parseInt((await env.ENTITLEMENTS.get('stats:people')) || '0', 10);
  await env.ENTITLEMENTS.put('stats:people', String(people + 1));
}

async function publicStats(env, cors) {
  let scans = 0;
  let people = 0;
  try {
    scans = parseInt((await env.ENTITLEMENTS.get('stats:scans')) || '0', 10) || 0;
    people = parseInt((await env.ENTITLEMENTS.get('stats:people')) || '0', 10) || 0;
  } catch {}

  // Floor to a round number so the site never claims a figure the counters
  // cannot back, and add the pre-counter baseline the owner verified.
  const floor10 = n => Math.floor(n / 10) * 10;
  return json({
    scans: floor10(STATS_BASELINE_SCANS + scans),
    people: floor10(STATS_BASELINE_PEOPLE + people)
  }, 200, cors);
}

/* ============================================================
 * Improve — Pro-only training/diet audit report
 * ============================================================ */
async function improveRequest(req, body, env, cors) {
  const claims = await verifyToken(bearerToken(req), env.TOKEN_SECRET);
  if (!claims) return errorResponse(401, 'invalid_token', cors);

  const ent = await readEntitlement(env, claims.email);
  if (!ent || !entitlementActive(ent)) {
    return errorResponse(402, 'payment_required', cors, { reason: 'entitlement_inactive' });
  }
  if (ent.tier !== 'pro' && ent.tier !== 'lifetime') {
    return errorResponse(402, 'payment_required', cors, { reason: 'pro_required', locked: true });
  }

  const email = claims.email;
  const ttl = secondsUntilTomorrow();
  if (await limitExceeded(env, 'rl:improve:' + todayKey() + ':email:' + hashish(email), IMPROVE_DAILY_CAP, ttl)) {
    return errorResponse(429, 'rate_limited', cors, { retry_after_seconds: ttl });
  }

  const inputs = sanitizeImproveInputs(body);
  const scan = await latestScanSummary(env, email);
  if (!scan) return errorResponse(400, 'bad_request', cors, { reason: 'no_scans' });

  const result = await callImproveModel(env, scan, inputs);
  if (result.refused) return json(result, 200, cors);

  // Stored so reopening the screen never costs another model call, and so the
  // form can re-populate on any device. The scan summary rides along so the
  // client can draw the body map. Never let a store failure eat a report.
  const record = { inputs, report: result, scan, created: nowSec() };
  try { await env.ENTITLEMENTS.put('improve:' + email, JSON.stringify(record)); } catch {}
  return json({ refused: false, report: result, scan, created: record.created }, 200, cors);
}

async function getImprove(req, env, cors) {
  const claims = await verifyToken(bearerToken(req), env.TOKEN_SECRET);
  if (!claims) return errorResponse(401, 'invalid_token', cors);
  const ent = await readEntitlement(env, claims.email);
  if (!ent || !entitlementActive(ent)) return errorResponse(402, 'payment_required', cors);
  if (ent.tier !== 'pro' && ent.tier !== 'lifetime') {
    return errorResponse(402, 'payment_required', cors, { reason: 'pro_required', locked: true });
  }
  let rec = null;
  try { rec = JSON.parse((await env.ENTITLEMENTS.get('improve:' + claims.email)) || 'null'); } catch {}
  return json({ record: rec }, 200, cors);
}

function sanitizeImproveInputs(body) {
  const intIn = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };
  const goal = IMPROVE_GOALS.has(String(body.goal || '')) ? String(body.goal) : 'gain';
  const stats = {
    height_cm: intIn(body.height_cm, 120, 230),
    weight_kg: intIn(body.weight_kg, 35, 250),
    training_years: intIn(body.training_years, 0, 60)
  };
  const intake = {
    calories_kcal: intIn(body.calories_kcal, 800, 8000),
    protein_g: intIn(body.protein_g, 20, 500)
  };
  const sets = {};
  if (body.sets && typeof body.sets === 'object' && !Array.isArray(body.sets)) {
    for (const k of IMPROVE_SET_KEYS) {
      const n = intIn(body.sets[k], 0, 60);
      if (n != null) sets[k] = n;
    }
  }
  const diet = typeof body.diet === 'string'
    ? body.diet.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, 2500)
    : '';
  return { goal, stats, intake, sets, diet };
}

// Protein adequacy is arithmetic, not judgement — compute it here and hand the
// model a verdict it is told to trust, so it can never advise "raise protein"
// to someone already inside or above the 1.6-2.2 g/kg range.
function improveDerivedFacts(inputs) {
  const facts = [];
  const w = inputs.stats.weight_kg;
  const p = inputs.intake.protein_g;
  const kcal = inputs.intake.calories_kcal;
  if (kcal != null) facts.push('Reported intake: roughly ' + kcal + ' kcal per day (self-reported).');
  if (p != null && w != null) {
    const gkg = Math.round((p / w) * 10) / 10;
    if (gkg >= 1.6) {
      facts.push('Reported protein: ' + p + ' g at ' + w + ' kg = ' + gkg + ' g/kg, which is ' +
        (gkg > 2.2 ? 'above' : 'within') + ' the 1.6-2.2 g/kg target. Protein is covered — do not advise raising it.');
    } else {
      facts.push('Reported protein: ' + p + ' g at ' + w + ' kg = ' + gkg + ' g/kg, below the 1.6-2.2 g/kg target. Raising protein toward roughly ' + Math.round(1.6 * w) + '-' + Math.round(2.2 * w) + ' g is a legitimate fix.');
    }
  } else if (p != null) {
    facts.push('Reported protein: ' + p + ' g per day (no bodyweight given, so grams per kg cannot be computed).');
  }
  return facts;
}

// Condense KV history into the freshest per-muscle picture: latest entry per
// region, latest score per muscle across regions, latest body-fat estimate.
async function latestScanSummary(env, email) {
  let list = [];
  try {
    list = JSON.parse((await env.ENTITLEMENTS.get('hist:' + email)) || '[]');
  } catch {}
  if (!Array.isArray(list) || !list.length) return null;

  const byRegion = {};
  let latestTs = 0;
  let bodyfat = null;
  for (const h of list) {
    if (!h || !h.region) continue;
    const ts = h.ts || 0;
    if (!byRegion[h.region] || ts >= (byRegion[h.region].ts || 0)) byRegion[h.region] = h;
    if (ts >= latestTs) {
      latestTs = ts;
      if (h.bodyfat_range) bodyfat = h.bodyfat_range;
    }
  }

  const muscles = {};
  const muscleTs = {};
  for (const h of Object.values(byRegion)) {
    for (const [k, v] of Object.entries(h.muscles || {})) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (muscleTs[k] == null || (h.ts || 0) >= muscleTs[k]) {
        muscles[k] = Math.max(0, Math.min(100, Math.round(n)));
        muscleTs[k] = h.ts || 0;
      }
    }
  }
  if (!Object.keys(muscles).length) return null;

  const regions = {};
  for (const [r, h] of Object.entries(byRegion)) {
    regions[r] = {
      score: h.score != null ? h.score : null,
      days_ago: Math.max(0, Math.round((nowSec() - (h.ts || 0)) / 86400))
    };
  }
  return { muscles, bodyfat_range: bodyfat || 'unknown', regions, latest_ts: latestTs };
}

async function callImproveModel(env, scan, inputs) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');

  const system = [
    'You are CALLOUT Improve, the training and diet adjustment engine of an AI physique assessment tool.',
    'Return one valid JSON object only. Do not include markdown, code fences, prose, explanations, or extra keys.',
    'Success schema: {"refused":false,"focus":"single top-priority sentence","training":{"read":"blunt read of their split vs their physique","changes":[{"area":"muscle or group","action":"what to change"}]},"diet":{"read":"blunt read of the diet vs the goal","changes":[{"what":"the change","why":"one-line reason"}]},"recheck_weeks":8}.',
    'If no diet text was provided, set "diet" to null. Each "changes" array holds 2 to 6 items. recheck_weeks is an integer from 4 to 12.',
    'Refusal schema: {"refused":true,"reason":"unsafe_request|insufficient_input"}. Refuse as unsafe_request if the inputs suggest disordered eating, a medical condition that needs professional care, or a goal of getting dangerously lean.',
    'Training rules: redistribute the weekly sets the user reports rather than inventing totals. Recommend ranges ("add 3-5 weekly sets"), never exact prescriptions. Account for indirect volume: presses also train front delts and triceps, rows and pulldowns train biceps, squats and deadlifts train the posterior chain. Reported biceps and triceps sets are direct isolation volume — weigh each against the single visual "arms" score plus the indirect pressing and pulling volume, and address them separately when the split is lopsided. If a lagging muscle already gets high reported volume, the bottleneck is likely technique, intensity, or recovery — say that instead of adding sets. If no sets were reported, give a priority order from the scan and say that is what it is.',
    'Diet rules: audit and adjust what they actually listed — direction and ranges only. Protein guidance relative to bodyweight (roughly 1.6-2.2 g per kg) — and do the arithmetic first: compute grams per kg from their reported intake and bodyweight, and if reported protein already sits within or above that range, say it is covered; never tell someone to raise protein into a range they already meet or exceed. Calorie guidance as a direction with a rough range ("roughly 300-500 kcal above maintenance"), chosen from the goal AND the visible conditioning and body-fat estimate. Suggest 2-4 concrete swaps grounded in foods they listed. Never give: exact calorie targets, meal-by-meal plans, aggressive deficits, any deficit advice for someone already visibly lean, supplement or drug advice, or medical claims.',
    'The scan data is ground truth for what the physique looks like; user inputs are self-reported and may be wrong. Where they contradict the scan, trust the scan and say so plainly.',
    'Tone: blunt, direct, specific, zero filler. Honest in both directions — credit what is already right. This is general fitness guidance, never medical advice.'
  ].join('\n');

  const derived = improveDerivedFacts(inputs);
  const userPrompt = [
    'Latest scan data: ' + JSON.stringify(scan),
    'User inputs: ' + JSON.stringify(inputs)
  ].concat(derived.length ? ['Precomputed facts (trust these over your own arithmetic): ' + derived.join(' ')] : [])
   .concat(['Return JSON only using the required schema.'])
   .join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ANTHROPIC_API_KEY
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: 1600,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }]
    })
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('AI provider failed: ' + resp.status);

  const text = data.content?.find(c => c.type === 'text')?.text || '';
  try {
    return validateImproveResult(parseJsonObject(text));
  } catch {
    return { refused: true, reason: 'report_failed' };
  }
}

function validateImproveResult(result) {
  if (!result || typeof result !== 'object' || typeof result.refused !== 'boolean') {
    throw new Error('schema');
  }
  if (result.refused) {
    if (!hasOnlyKeys(result, ['refused', 'reason'])) throw new Error('schema');
    const reason = IMPROVE_REFUSALS.has(result.reason) ? result.reason : 'insufficient_input';
    return { refused: true, reason };
  }
  if (!hasOnlyKeys(result, ['refused', 'focus', 'training', 'diet', 'recheck_weeks'])) {
    throw new Error('schema');
  }
  const focus = safeModelString(result.focus, 240);
  // 'area' is a short muscle tag; diet 'what' is a full change sentence and
  // needs room — a 60-char cap visibly truncated real reports mid-word.
  const training = validateImproveSection(result.training, 'area', 'action', 60, true);
  const diet = result.diet == null ? null : validateImproveSection(result.diet, 'what', 'why', 160, false);
  let weeks = Number(result.recheck_weeks);
  weeks = Number.isFinite(weeks) ? Math.max(4, Math.min(12, Math.round(weeks))) : 8;
  if (!focus || !training) throw new Error('schema');
  return { refused: false, focus, training, diet, recheck_weeks: weeks };
}

function validateImproveSection(sec, keyA, keyB, capA, required) {
  if (!sec || typeof sec !== 'object' || Array.isArray(sec)) {
    if (required) throw new Error('schema');
    return null;
  }
  if (!hasOnlyKeys(sec, ['read', 'changes'])) throw new Error('schema');
  const read = safeModelString(sec.read, 700);
  if (!read || !Array.isArray(sec.changes)) throw new Error('schema');
  const changes = [];
  for (const c of sec.changes.slice(0, 6)) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || !hasOnlyKeys(c, [keyA, keyB])) throw new Error('schema');
    const a = safeModelString(c[keyA], capA);
    const b = safeModelString(c[keyB], 300);
    if (!a || !b) throw new Error('schema');
    changes.push({ [keyA]: a, [keyB]: b });
  }
  if (!changes.length) throw new Error('schema');
  return { read, changes };
}

/* ============================================================
 * Turnstile
 * ============================================================ */
async function verifyTurnstile(env, token, ip) {
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.set('secret', env.TURNSTILE_SECRET);
    form.set('response', token);
    if (ip && ip !== 'noip') form.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const data = await r.json().catch(() => ({}));
    return !!data.success;
  } catch {
    return false;
  }
}

async function revokeEntitlement(env, email, details = {}) {
  email = normalizeEmail(email);
  if (!email) return;
  const ent = await readEntitlement(env, email);
  if (!ent) return;

  ent.status = 'revoked';
  ent.revoked_at = nowSec();
  ent.revoke_reason = details.reason || 'stripe_event';
  ent.updated = nowSec();
  ent.last_stripe_event = details;
  await writeEntitlement(env, email, ent);
}

function entitlementActive(ent) {
  if (!ent || ent.status !== 'active') return false;
  if (ent.tier === 'pro') {
    return !!ent.current_period_end && ent.current_period_end > nowSec();
  }
  return ent.tier === 'scan' || ent.tier === 'lifetime';
}

function chooseEntitlementTier(current, incoming) {
  const rank = { scan: 1, pro: 2, lifetime: 3 };
  if (!current) return incoming;
  return rank[incoming] >= rank[current] ? incoming : current;
}

// IP + user agent. Not an identity in any strong sense, but stable enough to
// stop one browser claiming unlimited free scans, and to keep the public
// people counter from counting the same visitor twice.
function deviceKey(req) {
  const ua = req.headers.get('user-agent') || 'noua';
  return hashish(clientIp(req) + '|' + ua);
}

async function consumeFreeScan(env, body, req) {
  // The free allowance is enforced on BOTH identities at once. Keying on the
  // email alone let anyone mint unlimited free scans by sending a fresh
  // made-up email per request; the device key (IP + user agent) always
  // applies, and the email key is added on top when present. Key shapes are
  // unchanged, so existing counters keep working.
  const email = normalizeEmail(body.email);
  const keys = ['free:i:' + deviceKey(req)];
  if (email) keys.push('free:e:' + email);

  for (const key of keys) {
    const used = parseInt((await env.ENTITLEMENTS.get(key)) || '0', 10);
    if (used >= FREE_SCANS) return { blocked: true, keys };
  }
  for (const key of keys) {
    const used = parseInt((await env.ENTITLEMENTS.get(key)) || '0', 10);
    await env.ENTITLEMENTS.put(key, String(used + 1), { expirationTtl: FREE_COUNTER_TTL });
  }
  return { blocked: false, keys };
}

async function refundFreeScan(env, keys) {
  for (const key of keys) {
    const used = parseInt((await env.ENTITLEMENTS.get(key)) || '0', 10);
    if (used > 0) {
      await env.ENTITLEMENTS.put(key, String(used - 1), { expirationTtl: FREE_COUNTER_TTL });
    }
  }
}

/* ============================================================
 * Stripe price mapping
 * ============================================================ */
function resolveTierFromStripeObject(obj, env) {
  const metadataTier = normalizeTier(obj?.metadata?.tier);
  const priceId = priceIdFromStripeObject(obj);
  const priceTier = tierFromPriceId(priceId, env);

  // Prefer Stripe-side metadata when present, but require price mapping to agree.
  // Metadata must be configured in Stripe dashboard/Payment Link, never supplied
  // by the browser. If metadata and price disagree, fail closed.
  if (metadataTier && priceTier && metadataTier !== priceTier) {
    return { ok: false, error: 'tier_price_mismatch', metadataTier, priceTier, priceId };
  }
  if (metadataTier && !priceTier) {
    return { ok: false, error: 'unknown_price_for_metadata_tier', metadataTier, priceId };
  }
  if (metadataTier) {
    return { ok: true, tier: metadataTier, metadataTier, priceTier, priceId };
  }
  if (priceTier) {
    return { ok: true, tier: priceTier, metadataTier: null, priceTier, priceId };
  }
  return { ok: false, error: 'unknown_price', metadataTier: null, priceTier: null, priceId };
}

function priceIdFromStripeObject(obj) {
  if (!obj) return '';
  if (obj.object === 'checkout.session') {
    return obj.line_items?.data?.[0]?.price?.id || obj.metadata?.price_id || '';
  }
  if (obj.object === 'invoice') {
    return obj.lines?.data?.find(l => l.price?.id)?.price?.id || '';
  }
  return obj.line_items?.data?.[0]?.price?.id ||
    obj.lines?.data?.find?.(l => l.price?.id)?.price?.id ||
    obj.price?.id ||
    obj.metadata?.price_id ||
    '';
}

function tierFromPriceId(priceId, env) {
  const map = new Map([
    [env.STRIPE_PRICE_SCAN, 'scan'],
    [env.STRIPE_PRICE_PRO, 'pro'],
    [env.STRIPE_PRICE_LIFETIME, 'lifetime'],
    ['price_1UMBJMP3OFdhFtZ4LmdZcAFU', 'scan'],
    ['price_1UMBRrP3OFdhFtZ4M66hMZ8L', 'pro'],
    ['price_1UMBUKP3OFdhFtZ4oWuGXk6M', 'pro'],
    ['price_1TeJyPP3OFdhFtZ40e1UB74j', 'lifetime'],
    ['price_1TeJxkP3OFdhFtZ4pO5qOj4z', 'pro'],
    ['price_1TeJwLP3OFdhFtZ4XUORlDYt', 'scan'],
    ['price_1TeJnGP3OFdhFtZ4VQY4eYmQ', 'pro'],
    ['price_1TeJkvP3OFdhFtZ471TOe6Iq', 'scan'],
    ['price_1TeJhbP3OFdhFtZ4iPThguiP', 'scan'],
    ['price_1TdDEvP3OFdhFtZ401ZNnIfg', 'scan']
  ].filter(([id]) => !!id));
  return map.get(priceId) || null;
}

function normalizeTier(tier) {
  tier = String(tier || '').trim().toLowerCase();
  return ['scan', 'pro', 'lifetime'].includes(tier) ? tier : null;
}

function periodEndFromInvoice(obj) {
  const line = obj?.lines?.data?.find(l => l.period?.end);
  return line?.period?.end || null;
}

function subscriptionPeriodEnd(sub, env) {
  if (sub?.current_period_end) return sub.current_period_end;
  // Newer webhook versions put billing periods on subscription items.
  const ends = (sub?.items?.data || [])
    .filter(item => tierFromPriceId(idOf(item.price), env) === 'pro')
    .map(item => Number(item.current_period_end))
    .filter(end => Number.isFinite(end) && end > 0);
  return ends.length ? Math.min(...ends) : null;
}

function emailFromCheckoutSession(session) {
  return normalizeEmail(session.customer_details?.email || session.customer_email);
}

async function emailForStripeCustomer(env, customerId, fallbackEmail) {
  const fallback = normalizeEmail(fallbackEmail);
  if (customerId) {
    const mapped = normalizeEmail(await env.ENTITLEMENTS.get('customer:' + customerId));
    if (mapped) return mapped;

    try {
      const customer = await retrieveCustomer(env, customerId);
      const email = normalizeEmail(customer.email);
      if (email) {
        await env.ENTITLEMENTS.put('customer:' + customerId, email);
        return email;
      }
    } catch {
      // Fail closed for entitlement changes that require Stripe confirmation.
      return fallback || null;
    }
  }
  return fallback || null;
}

function idOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.id) return value.id;
  return null;
}

/* ============================================================
 * AI grading
 * ============================================================ */
async function callModel(env, region, image, mediaType, strict, normalizedImage = null) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');

  const spec = VIEW_SPEC[region];

  // Preserve this raw vision rubric for repeatable model requests. Mass is
  // translated to the product scale after validation; final tier labels are
  // derived from the calibrated scores, not these raw development anchors.
  const system = [
    'You are CALLOUT, an AI physique photo assessment tool.',
    'Return one valid JSON object only. Do not include markdown, code fences, prose, explanations, or extra keys.',
    'You must refuse if the image is explicit or sexualized, there are multiple people, the subject is unclear, the image is non-human, or the image is too blurry, cropped, dark, obstructed, or otherwise impossible to grade. Age eligibility is validated separately from the user-provided date of birth; never infer, estimate, or comment on age from appearance.',
    'Refusal schema: {"refused":true,"reason":"explicit|unclear_subject|non_human|unclear_view"}.',
    'Assessment schema: {"refused":false,"photo_read":"string","mass_evidence":{"arms":{"observation":"visible muscle shape or thickness","reference":"visible local anatomical reference, or null","quality":"clear|limited|unusable"}},"muscles":{"arms":{"score":0,"confidence":"low|medium|high"},"conditioning":{"score":0,"confidence":"low|medium|high"}},"bodyfat_range":"rough visual range or unknown","verdict":"short direct critique, no medical advice","weakest_visible_area":"string","strongest_visible_area":"string","next_focus":"string"}. The arms entries illustrate the per-muscle schema: use the allowed muscle keys for this view, with one mass_evidence entry for every scored size muscle. Do not put conditioning in mass_evidence.',
    'Emit photo_read and mass_evidence BEFORE muscles. Record only visible observations and reference anatomy, not hidden reasoning. Grade each supported muscle independently; do not choose a holistic tier or force the muscle scores toward a common band. The server derives the tier afterwards.',
    'photo_read: one or two sentences of plain observation before you grade — which regions are actually in frame, how the lighting, distance, pose and clothing affect the read, and the concrete structural cues you can see (frame width, muscle projection, insertions, limb girth vs joints). Observation only, no scores and no advice.',
    'Mass means visible muscular development relative to the subject\'s skeletal frame, not kilograms of muscle. Never infer physical dimensions, camera distance in metres, or muscle weight from this photo.',
    'Framing invariance: how much of the image the person fills, crop tightness, empty background and apparent pixel size are not evidence of development. With unchanged visible anatomy and pose, a tighter crop or a smaller person in a wider frame must not raise or lower the score of the same muscle. Judge only overlapping visible muscles when coverage differs.',
    'Perspective: close-camera enlargement, wide-angle distortion, camera tilt, foreshortening and a limb reaching toward the lens can exaggerate apparent thickness. Use local muscle-to-frame proportions only when both are visible at comparable depth and orientation. Never use the head, background objects or a guessed distance as a universal scale. Cropping cannot undo perspective, and enlarging a distant subject cannot recover missing detail.',
    'mass_evidence quality: clear = readable muscle shape, contour and thickness; limited = supported development is visible but pose, perspective, clothing, body fat or detail limits precision; unusable = development cannot be assessed at all. A sharply visible joint is helpful but NOT required: supported muscle contour and proportions within the body can still justify a score. Keep observation and reference to one short phrase each. reference must name visible anatomical context, or be JSON null when unavailable. Missing reference affects confidence only, never the size score; do not omit an otherwise readable muscle solely for this reason. Limited quality permits at most medium confidence. Omit unusable muscles and refuse with unclear_view only if no size muscle is assessable. Reduced detail is uncertainty, not evidence of small muscle.',
    'Scene context: use the original image to assess framing, body orientation, mirror use and possible near-camera exaggeration. Nearby objects may provide qualitative context, but furniture, doors and gym equipment are not fixed-size rulers and may be at a different depth. Do not invent object dimensions or camera distance, or apply an arbitrary distance multiplier to muscle scores.',
    'Only score visible areas. Omit muscle keys that cannot be assessed from the requested view.',
    'Always include a conditioning score — overall leanness is visible in any physique photo, so conditioning must never be omitted.',
    'Scores must be numbers from 0 to 100. Confidence must be exactly low, medium, or high.',
    'Compare visible development with the general adult population, including adults who do not train. Do not use gym regulars, fitness influencers or competitive bodybuilders as the average. These are product grading anchors, not measured population percentiles. Use the whole 0-100 scale:',
    '90-100 = elite: exceptional muscular size and thickness relative to the general adult population. This measures DEVELOPMENT, NOT leanness: award it for genuinely huge muscle whether the physique is soft or shredded, and whether or not there is visible separation, dryness, or vascularity. Rare, but award it whenever the underlying mass is genuinely there.',
    '75-89 = advanced: a clearly good, well-developed physique: pronounced muscle shape, thickness and projection relative to the local frame — lean or not. Competition-level size is not required.',
    '61-74 = experienced: solid, clearly above-average visible development; a recognisably athletic muscle with meaningful thickness. A relative weak point is not automatically average.',
    '40-60 = developing: ordinary adult development through modest training effect; around 40 represents ordinary visible development, and 50-60 shows noticeable progress above that.',
    '25-39 = beginner: minimal visible development.',
    '0-24 = no visible training adaptation.',
    'Use anatomical development anchors for each muscle: little discernible muscle development near 15-25; modest muscle contour and thickness near 45-55; clear athletic development relative to the local frame near 65-75; a good physique with pronounced muscle projection and thickness near 78-86; exceptional development near 92+. Do not infer training years, competition status, or drug use to assign a number. Skeletal width and muscle insertions are context, not development points by themselves.',
    'Do not compress scores into the 50-70 band out of caution: a genuinely big or impressive physique scores 75 or higher, and an untrained-looking one stays below 50. Muscular mass is the primary driver of a muscle score — reward it heavily and use the top of the scale for genuinely massive development.',
    'Score each muscle for the actual muscle present, judged as if normalized for body fat — not for how full or flat the silhouette happens to look. Body fat inflates apparent size and leanness deflates it, so the same muscle looks bigger on a soft physique and smaller on a lean one; do not be fooled in either direction. A lean, tight physique is NOT smaller, and a soft, full one is NOT bigger, than the muscle actually underneath it.',
    'Use visible delt projection relative to the shoulder frame, chest thickness in an assessable profile, quad sweep relative to the leg, and limb girth relative to surrounding anatomy. These are imperfect visual cues, not measurements immune to fat or perspective. Read supported muscle contours even when individual joints are indistinct; do not invent hidden thickness under fat or clothing. Avoid using raw silhouette volume as muscle evidence.',
    'Leanness, separation, dryness, and vascularity belong ONLY in the conditioning score — never add them to, nor subtract them from, a muscle size score. A physique can be elite through mass alone; equally, being very lean never makes a muscle small on its own. Do not cap a size score for being soft, and do not cap it for being shredded.',
    'Abs: score the size and muscular thickness of the abdominal wall, not only how lean it is — a thick, hard, developed midsection scores well even when higher body fat hides the separation. Distinguish genuine muscular thickness from a soft or distended belly, which does not.',
    'Conditioning reflects leanness, separation, dryness, and vascularity only. Score it honestly, but keep it fully independent of the muscle size scores: on a very massive physique, ordinary conditioning lowers the conditioning score alone — it must not drag down how the mass itself is graded.',
    'Conditioning still requires muscle to reveal: a lean but unmuscular frame (low body fat, minimal muscle) is not "shredded" — with little muscle there is nothing to separate or strike, so score its conditioning only moderate, never high. Genuinely high conditioning needs both low body fat AND visible muscle.',
    'Never lower a score because the photo is poor. If lighting, blur, angle, or framing limits the read on a muscle, lower that muscle\'s confidence or omit the key — do not guess low.',
    'Blunt means honest in both directions: credit genuine strengths as directly as you call out weaknesses. On a high-level physique, weakest_visible_area is the relatively weakest part, not manufactured criticism.',
    'bodyfat_range must be a rough visual estimate such as "unknown", "roughly 18-24% visually", or a similarly cautious range. Never present it as medical truth.',
    'Anchor the body-fat estimate visually rather than guessing a round number: separated abs with visible vascularity and striations read roughly 6-10%; a flat, clearly outlined four-to-six pack reads roughly 11-15%; a soft outline of the upper abs only reads roughly 16-20%; no ab definition but a defined waist reads roughly 21-26%; a rounded waist with no muscular outline reads 27% or above. Give the range that matches what you can see, and keep the estimate consistent with the conditioning score you gave.',
    'The verdict and focus fields must be concise, direct, non-medical, and based only on visible physique development in the photo.',
    'The verdict must be specific to this photo: name the actual body parts and what you saw in them. Never write a line that would fit any physique.'
  ].join('\n');

  const userPrompt = [
    'Assess this image for requested view: ' + region + (spec ? ' (' + spec.label + ').' : '.'),
    spec ? 'Muscles you may score from this view, and nothing else: ' + spec.muscles.join(', ') + '. Omit any of these that this particular photo does not actually show.' : '',
    spec ? 'What to read from this angle: ' + spec.cues : '',
    normalizedImage ? 'Two images follow. Image 1 is the original scene and remains authoritative for eligibility, subject count, view and conditioning. Image 2 is a client-provided detail crop, intended to show the same subject from Image 1. Verify that the anatomy matches; ignore it if inconsistent. Use matching detail to read development while retaining context from Image 1. The enlarged presentation is not a larger physique and reveals no additional physical scale. Never let a crop hide ineligible content or another person in the original.' : '',
    strict ? 'Your previous response was not valid JSON in the required schema. Return the raw JSON object only — no code fences, no commentary, no extra keys — starting with { and ending with }.' : '',
    'Return JSON only using the required schema, keys in the required order.'
  ].filter(Boolean).join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ANTHROPIC_API_KEY
    },
    body: JSON.stringify({
      // claude-3-5-sonnet-20241022 (previous default) was retired 2025-10-28
      // and 404s. claude-sonnet-5 is Anthropic's documented drop-in
      // replacement. It rejects non-default temperature (400) and runs
      // adaptive thinking unless disabled, so: no temperature, thinking off
      // (this grading task needs neither). If you override ANTHROPIC_MODEL,
      // pick a current vision model, e.g. claude-haiku-4-5 to cut cost.
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      // Short per-muscle evidence needs room in wide/full-body views.
      max_tokens: 2600,
      thinking: { type: 'disabled' },
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          ...(normalizedImage ? [
            { type: 'text', text: 'Image 2: detail crop. Same intended subject and exposure; verify against the original.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: normalizedImage } }
          ] : [])
        ]
      }]
    })
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('AI provider failed: ' + resp.status);

  const text = data.content?.find(c => c.type === 'text')?.text || '';
  const parsed = parseJsonObject(text);
  return validateModelResult(parsed, region);
}

// One retry before giving up. A malformed or truncated response is a formatting
// miss, not a verdict on the photo — surfacing scan_failed for it costs the user
// a scan attempt and reads as the product being broken. Provider errors
// (non-2xx, network) still throw so the caller can refund the free scan.
async function gradePhoto(env, region, image, mediaType, normalizedImage = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callModel(env, region, image, mediaType, attempt > 0, normalizedImage);
    } catch (err) {
      if (String(err?.message || '').startsWith('AI provider failed')) throw err;
      if (attempt === 1) {
        console.error('CALLOUT grading unusable after retry', safeErrorLog(err));
        return { refused: true, reason: 'scan_failed' };
      }
    }
  }
  return { refused: true, reason: 'scan_failed' };
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('AI response was not JSON');
  }
}

function validateModelResult(result, region) {
  if (!result || typeof result !== 'object' || typeof result.refused !== 'boolean') {
    throw new Error('schema');
  }

  if (result.refused) {
    if (!hasOnlyKeys(result, ['refused', 'reason'])) throw new Error('schema');
    const reason = REFUSAL_REASONS.has(result.reason) ? result.reason : 'unclear_view';
    return { refused: true, reason };
  }

  if (!hasOnlyKeys(result, [
    'refused',
    'photo_read',
    'mass_evidence',
    'muscles',
    'bodyfat_range',
    'verdict',
    'weakest_visible_area',
    'strongest_visible_area',
    'next_focus'
  ])) {
    throw new Error('schema');
  }

  if (!result.muscles || typeof result.muscles !== 'object' || Array.isArray(result.muscles)) {
    throw new Error('schema');
  }

  if (!hasOnlyKeys(result.muscles, MUSCLE_KEYS)) throw new Error('schema');
  const evidence = result.mass_evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      !hasOnlyKeys(evidence, MUSCLE_KEYS.filter(k => k !== 'conditioning'))) throw new Error('schema');

  // A muscle the requested angle physically cannot show is a hallucination, not
  // a read — and in the frontend a stray back or leg score raises the capped
  // overall grade. Drop them instead of trusting them.
  const allowed = VIEW_SPEC[region] ? new Set(VIEW_SPEC[region].muscles) : new Set(MUSCLE_KEYS);

  const muscles = {};
  const massEvidence = {};
  for (const key of MUSCLE_KEYS) {
    const v = result.muscles[key];
    if (v == null) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('schema');
    if (!hasOnlyKeys(v, ['score', 'confidence'])) throw new Error('schema');
    const score = v.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('schema');
    if (!CONFIDENCE_VALUES.has(v.confidence)) throw new Error('schema');
    if (!allowed.has(key)) continue;
    let confidence = v.confidence;
    if (key !== 'conditioning') {
      const read = evidence[key];
      if (!read || typeof read !== 'object' || Array.isArray(read) ||
          !hasOnlyKeys(read, ['observation', 'reference', 'quality']) ||
          !MASS_QUALITY_VALUES.has(read.quality)) throw new Error('schema');
      const observation = safeModelString(read.observation, 180);
      const reference = safeModelString(read.reference, 120);
      if (!observation || (read.reference !== null && !reference)) throw new Error('schema');
      massEvidence[key] = { observation, reference: reference || null, quality: read.quality };
      // No numeric penalty for a bad photo: omit unsupported evidence instead.
      if (read.quality === 'unusable') continue;
      if ((read.quality === 'limited' || !reference) && confidence === 'high') confidence = 'medium';
    }
    muscles[key] = {
      score: clampScore(score),
      confidence
    };
  }

  if (!Object.keys(muscles).some(k => k !== 'conditioning')) return { refused: true, reason: 'unclear_view' };
  if (!muscles.conditioning) throw new Error('schema');

  const bodyfat = safeModelString(result.bodyfat_range, 80) || 'unknown';
  const verdict = safeModelString(result.verdict, 500);
  const weakest = safeModelString(result.weakest_visible_area, 80);
  const strongest = safeModelString(result.strongest_visible_area, 80);
  const nextFocus = safeModelString(result.next_focus, 180);
  const photoRead = safeModelString(result.photo_read, 400);
  const tier = tierFromMuscles(muscles);

  if (!photoRead || !verdict || !weakest || !strongest || !nextFocus) throw new Error('schema');

  return {
    refused: false,
    photo_read: photoRead,
    tier,
    mass_evidence: massEvidence,
    muscles,
    bodyfat_range: bodyfat,
    verdict,
    weakest_visible_area: weakest,
    strongest_visible_area: strongest,
    next_focus: nextFocus
  };
}

/* ============================================================
 * Post-model calibration
 * ============================================================ */
// Convert the existing vision rubric's raw development scale into the product
// mass scale, intended to reference all adult men. These provisional anchors
// are a product choice informed by a small synthetic reference set, not
// measured population means/SDs. Keep the
// model prompt stable: the v5 prompt rewrite lowered high-end mass and shifted
// conditioning in photo tests. Interpolation depends only on raw muscle size;
// it never uses conditioning, body fat, confidence, photo identity or a tier.
const MASS_CALIBRATION_POINTS = [[0, 0], [35, 50], [55, 70], [100, 100]];
const CONDITIONING_CALIBRATION_OFFSET = -4;

function calibrateMassScore(score) {
  const raw = clampScore(score);
  for (let i = 1; i < MASS_CALIBRATION_POINTS.length; i++) {
    const [x0, y0] = MASS_CALIBRATION_POINTS[i - 1];
    const [x1, y1] = MASS_CALIBRATION_POINTS[i];
    if (raw <= x1) return clampScore(y0 + (raw - x0) * (y1 - y0) / (x1 - x0));
  }
  return raw;
}

function calibrateResult(result) {
  if (!result || result.refused) return result;
  const adjusted = Object.fromEntries(Object.entries(result.muscles || {}).map(([key, value]) =>
    key === 'conditioning' || value == null ? [key, value] : [key, { ...value, score: calibrateMassScore(value.score) }]
  ));
  if (adjusted.conditioning) adjusted.conditioning = { ...adjusted.conditioning, score: clampScore(adjusted.conditioning.score + CONDITIONING_CALIBRATION_OFFSET) };
  const out = { ...result, muscles: adjusted };
  out.tier = tierFromMuscles(out.muscles);
  alignConditioningToBodyfat(out);
  return out;
}

function tierFromMuscles(muscles) {
  const values = Object.entries(muscles || {}).filter(([k]) => k !== 'conditioning').map(([, v]) => v.score);
  if (!values.length) return null;
  const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  return Object.keys(TIER_BANDS).find(k => avg >= TIER_BANDS[k][0]) || 'untrained';
}

// Conditioning is leanness — it cannot sit far from the model's own body-fat
// estimate. Clamp only clear contradictions, with wide slack, so an honest
// judgement call is left alone.
function alignConditioningToBodyfat(result) {
  const cond = result.muscles.conditioning;
  if (!cond) return;
  const implied = conditioningFromBodyfat(result.bodyfat_range);
  if (implied == null) return;

  const SLACK = 15;
  const low = Math.max(0, implied - SLACK);
  const high = Math.min(100, implied + SLACK);
  if (cond.score >= low && cond.score <= high) return;

  result.muscles.conditioning = {
    ...cond,
    score: clampScore(cond.score < low ? low : high)
  };
}

// Rough leanness score implied by a body-fat range string. Mirrors
// condFromBodyfat() in index.html, minus the mass damping — this pass only
// checks the model against itself.
function conditioningFromBodyfat(bf) {
  const nums = (String(bf || '').match(/\d+(\.\d+)?/g) || []).map(Number).filter(n => n > 0 && n < 60);
  if (!nums.length) return null;
  const mid = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.max(8, Math.min(96, Math.round(95 - (mid - 6) * 2.8)));
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function safeModelString(value, maxLen) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.slice(0, maxLen);
}

function hasOnlyKeys(obj, allowed) {
  const set = new Set(allowed);
  return Object.keys(obj).every(k => set.has(k));
}

/* ============================================================
 * Helpers
 * ============================================================ */
function corsHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const configured = String(env.APP_ORIGINS || env.APP_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const localDev = env.ALLOW_LOCAL_DEV === '1' || configured.some(isLocalOrigin);
  const localOrigin = origin === 'null' || isLocalOrigin(origin);
  const allowed = !origin || configured.includes(origin) || (localDev && localOrigin);
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  };
  if (origin && configured.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (origin && !configured.includes(origin) && localDev && localOrigin) headers['Access-Control-Allow-Origin'] = '*';
  return { allowed, headers };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

function errorResponse(status, code, cors, extra = {}) {
  return json({ error: code, ...extra }, status, cors);
}

async function readJsonBody(req, maxBytes) {
  const text = await readTextBody(req, maxBytes);
  return JSON.parse(text);
}

async function readTextBody(req, maxBytes) {
  const len = Number(req.headers.get('content-length') || '0');
  if (len && len > maxBytes) throw new Error('body_too_large');
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error('body_too_large');
  return text;
}

function isValidBase64Image(image) {
  if (!image || typeof image !== 'string') return false;
  if (image.startsWith('data:')) return false;
  if (image.length > MAX_IMAGE_BASE64_CHARS) return false;
  if (image.length < 64) return false;
  if (image.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(image);
}

async function limitExceeded(env, key, limit, ttlSeconds) {
  const used = parseInt((await env.ENTITLEMENTS.get(key)) || '0', 10);
  if (used >= limit) return true;
  await env.ENTITLEMENTS.put(key, String(used + 1), { expirationTtl: ttlSeconds });
  return false;
}

function clientIp(req) {
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'noip').split(',')[0].trim();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilTomorrow() {
  const now = Date.now();
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((d.getTime() - now) / 1000));
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin || '');
}

function safeErrorLog(err) {
  if (!err) return 'unknown';
  return String(err.message || err).slice(0, 240);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  if (!email || email.length > 254) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return false;
  if (/[<>"'`;\\]/.test(email)) return false;
  return true;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function hashish(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function subscribeEmail(req, body, env, cors) {
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) {
    return json({ ok: false, error: 'bad_request' }, 400, cors);
  }

  const ttl = secondsUntilTomorrow();
  const ipBucket = 'ip:' + hashish(clientIp(req));
  const emailBucket = 'email:' + hashish(email);
  const ipLimited = await limitExceeded(env, 'rl:subscribe:' + todayKey() + ':' + ipBucket, SUBSCRIBE_IP_DAILY_CAP, ttl);
  const emailLimited = await limitExceeded(env, 'rl:subscribe:' + todayKey() + ':' + emailBucket, SUBSCRIBE_EMAIL_DAILY_CAP, ttl);
  if (ipLimited || emailLimited) {
    return json({ ok: false, error: 'rate_limited' }, 429, cors);
  }

  try {
    await syncSignupContact(env, email, body.consent === true);
  } catch {
    return json({ ok: false, error: 'signup_unavailable', message: 'Could not complete signup. Please try again.' }, 503, cors);
  }
  return json({ ok: true }, 200, cors);
}

// All signup paths share durable delivery state. Capture is separate from
// marketing permission, and retries never fabricate or revoke that permission.
async function syncSignupContact(env, email, consented = false) {
  const key = 'lead:' + email;
  const previous = await env.ENTITLEMENTS.get(key, 'json');
  if (previous?.mailerlite_synced === true && (!consented || previous.consent_marketing)) return;
  const lead = { email, created: previous?.created || nowSec(),
    consent_marketing: previous?.consent_marketing === true || consented,
    mailerlite_synced: false };
  await env.ENTITLEMENTS.put(key, JSON.stringify(lead));
  await pushToMailerLite(env, email);
  lead.mailerlite_synced = true;
  await env.ENTITLEMENTS.put(key, JSON.stringify(lead));
}

// Upsert the signup contact without overriding an existing unsubscribe status.
// Auth failures alone indicate a possible Classic API key.
async function pushToMailerLite(env, email) {
  if (!env.MAILERLITE_API_KEY) throw new Error('mailerlite_not_configured');
  const groupId = env.MAILERLITE_GROUP_ID;
  const payload = { email };
  if (groupId) payload.groups = [String(groupId)];
  const r = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.MAILERLITE_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
  });
  if (r.ok) return;
  if (r.status !== 401 && r.status !== 403) throw new Error('mailerlite_delivery_failed');
  const url = groupId
    ? 'https://api.mailerlite.com/api/v2/groups/' + encodeURIComponent(groupId) + '/subscribers'
    : 'https://api.mailerlite.com/api/v2/subscribers';
  const classic = await fetch(url, {
    method: 'POST',
    headers: { 'X-MailerLite-ApiKey': env.MAILERLITE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, resubscribe: false }), signal: AbortSignal.timeout(10000)
  });
  if (!classic.ok) throw new Error('mailerlite_delivery_failed');
}
