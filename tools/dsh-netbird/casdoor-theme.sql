-- Casdoor login-page theme for the NetBird sign-in app (owner `admin`, name `netbird`).
--
-- Applied against the Casdoor Postgres on `tx`:
--
--   docker exec -i casdoor-db psql -U casdoor -d casdoor -v ON_ERROR_STOP=1 < casdoor-theme.sql
--
-- Casdoor reads these rows per request, so nothing needs a restart. Only the
-- fields below reach the login page in this build (checked in the served
-- bundles): `logo`/`logoDark`/`favicon`/`title` come from the app,
-- `themeData` feeds the CSS variables, `formOffset=4` switches the layout to
-- two panels and only then is `formSideHtml` rendered (as `.side-image`),
-- `formCss` is injected as a <style>, and `footerHtml` REPLACES the built-in
-- "Powered by Casdoor" footer outright. The narrow layout is a DIFFERENT
-- component that reads `formCssMobile` instead of `formCss` (AuthLayout picks
-- `formCssMobile` on a small viewport), so the Feishu-first rules have to be
-- written twice; with only `formCss` set, a phone gets the stock Casdoor form
-- with the password fields visible and Feishu as a bare icon.
--
-- The brand mark is the app's own launcher icon
-- (tools/netbird-client/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png).
-- Both files are served from the SSO origin itself, so there is no cross-origin
-- dependency and the APK channel's atomic publish cannot wipe them:
--
--   /www/wwwroot/sso-brand/{logo.png,favicon.png}
--   location /brand/ { alias /www/wwwroot/sso-brand/; }   # in sso-casdoor.conf
--
-- Sign-in is Feishu-first: the provider row is restyled into a full-width
-- primary button and the password form is hidden until the footer switch is
-- ticked. That switch is a checkbox in `footerHtml` plus `:has()` in the CSS -
-- Casdoor renders OAuth providers only as icons and its signin-method tabs
-- cover just Password/code/WebAuthn/WeChat, so there is no native tab for a
-- generic provider. The `!important` flags are required: Tailwind's own
-- `display` utilities otherwise win over the hide rules.

BEGIN;

UPDATE application SET
  title = 'Anywhere Work',
  -- The narrow layout labels the logo with display_name; the desktop one uses title.
  display_name = 'Anywhere Work',
  logo = 'https://sso.example.com/brand/logo.png',
  logo_dark = 'https://sso.example.com/brand/logo.png',
  favicon = 'https://sso.example.com/brand/favicon.png',
  theme_data = '{"themeType":"default","colorPrimary":"#2563EB","borderRadius":10,"isCompact":false,"isEnabled":true}'::json,
  form_offset = 4,
  -- Do NOT hide the signup entry point with `enable_sign_up = false`: Casdoor's
  -- OAuth path (controllers/auth.go, the "Sign up via OAuth" branch) requires
  -- that flag, so turning it off also rejects a Feishu login for anyone who is
  -- not already a Casdoor user. `disable_self_signup` closes only the password
  -- signup route: the login page stops rendering the signup link and SignupPage
  -- refuses without an invitation code, while provider logins still provision.
  --
  -- Pre-created accounts still bind on login: Lark reports EmailVerified for
  -- any non-empty email, and the default binding rule matches Email then Phone.
  enable_sign_up = true,
  disable_self_signup = true,
  -- The only two methods we want: Password and the Feishu provider.
  enable_code_signin = false,
  enable_web_authn = false,
  enable_guest_signin = false,

  footer_html = $aw$<div class="aw-switch">
  <input type="checkbox" id="aw-pw" class="aw-pw-check">
  <label for="aw-pw" class="aw-switch-label"><span class="aw-switch-on">使用账号密码登录</span><span class="aw-switch-off">改为飞书登录</span></label>
</div>
<span class="aw-foot">Anywhere Work · 网络接入由 NetBird 提供</span>$aw$,
  form_css = $aw$.side-image { background: linear-gradient(158deg,#080D17 0%,#111A2B 100%); padding: 44px; }
.login-panel { border-radius: 18px; box-shadow: 0 18px 50px rgba(12,24,48,.10); }
.aw-points li::before { content: ""; position: absolute; left: 0; top: 7px; width: 8px; height: 8px; border-radius: 50%; background: #3B82F6; }
@media (min-width: 1024px) { .login-logo-box { display: none; } }

/* Card heading and hint: two separate pseudo-elements so each can be styled. */
.login-form > .space-y-6::before { content: "登录"; display: block; font-size: 22px; font-weight: 600; color: #0F1B2D; }
form.space-y-4::before { content: "使用飞书账号登录，或切换到账号密码登录"; display: block; font-size: 13px; line-height: 1.6; color: #4A5B70; }

/* Feishu is the default action: the provider row becomes a full-width primary button. */
div:has(> button > img[alt="Feishu"]) { width: 100%; }
div:has(> button > img[alt="Feishu"]) > button {
  display: flex; width: 100%; height: 44px; align-items: center; justify-content: center; gap: 10px;
  border: 0; border-radius: 10px; background: #2563EB; color: #fff;
}
div:has(> button > img[alt="Feishu"]) > button:hover { background: #1D4ED8; }
div:has(> button > img[alt="Feishu"]) > button img { width: 20px; height: 20px; filter: brightness(0) invert(1); }
div:has(> button > img[alt="Feishu"]) > button::after { content: "使用飞书登录"; font-size: 15px; font-weight: 500; }

/* The password path is opt-in; the toggle sits in the footer, under the card. Tailwind's
   own display utilities win without !important, which is why the hide rules need it. */
.login-username, .login-password, .login-forget-password, .login-button-box { display: none !important; }
form > .space-y-4 > div:first-child { display: none !important; }
body:has(#aw-pw:checked) .login-username { display: block !important; }
body:has(#aw-pw:checked) .login-password { display: block !important; }
body:has(#aw-pw:checked) .login-forget-password { display: flex !important; }
body:has(#aw-pw:checked) .login-button-box { display: block !important; }
body:has(#aw-pw:checked) form > .space-y-4 > div:first-child { display: flex !important; }
.aw-pw-check { display: none; }
.aw-switch { margin-bottom: 8px; }
.aw-switch-label { cursor: pointer; color: #2563EB; font-size: 13px; font-weight: 500; text-decoration: underline; text-underline-offset: 3px; }
.aw-switch-off { display: none; }
body:has(#aw-pw:checked) .aw-switch-on { display: none; }
body:has(#aw-pw:checked) .aw-switch-off { display: inline; }

/* Default (Feishu) mode: one short line fills the card and sets expectations. */
form.space-y-4::after { content: "首次登录会自动创建账号，之后只显示你有权限的机器"; display: block; font-size: 12px; line-height: 1.6; color: #586A80; margin-top: 12px; }
body:has(#aw-pw:checked) form.space-y-4::after { display: none; }

/* No email or SMS provider is configured, so the reset link is a dead end. */
.login-forget-password a { display: none; }$aw$,

  -- Phones read this field instead of form_css: same intent, sized for the
  -- narrow card (the brand panel and the side HTML never render there).
  form_css_mobile = $aw$/* Phones: the narrow layout reads formCssMobile, not formCss (AuthLayout picks
   formCssMobile when the viewport is small), so the Feishu-first rules need a
   copy tuned for the narrow card. */
.login-panel { border-radius: 18px; }
.login-username, .login-password, .login-forget-password, .login-button-box { display: none !important; }
form > .space-y-4 > div:first-child { display: none !important; }
body:has(#aw-pw:checked) .login-username { display: block !important; }
body:has(#aw-pw:checked) .login-password { display: block !important; }
body:has(#aw-pw:checked) .login-forget-password { display: flex !important; }
body:has(#aw-pw:checked) .login-button-box { display: block !important; }
body:has(#aw-pw:checked) form > .space-y-4 > div:first-child { display: flex !important; }
form.space-y-4::before { content: "使用飞书账号登录，或切换到账号密码登录"; display: block; text-align: center; font-size: 13px; line-height: 1.6; color: #4A5B70; margin-bottom: 12px; }
form.space-y-4::after { content: "首次登录会自动创建账号，之后只显示你有权限的机器"; display: block; text-align: center; font-size: 12px; line-height: 1.6; color: #586A80; margin-top: 12px; }
body:has(#aw-pw:checked) form.space-y-4::after { display: none; }
div:has(> button > img[alt="Feishu"]) { width: 100%; }
div:has(> button > img[alt="Feishu"]) > button { display: flex; width: 100%; height: 48px; align-items: center; justify-content: center; gap: 10px; border: 0; border-radius: 12px; background: #2563EB; color: #fff; }
div:has(> button > img[alt="Feishu"]) > button:hover { background: #1D4ED8; }
div:has(> button > img[alt="Feishu"]) > button img { width: 20px; height: 20px; filter: brightness(0) invert(1); }
div:has(> button > img[alt="Feishu"]) > button::after { content: "使用飞书登录"; font-size: 15px; font-weight: 500; }
.login-forget-password a { display: none; }
.aw-pw-check { display: none; }
.aw-switch { margin-bottom: 8px; }
.aw-switch-label { cursor: pointer; color: #2563EB; font-size: 13px; font-weight: 500; text-decoration: underline; text-underline-offset: 3px; }
.aw-switch-off { display: none; }
body:has(#aw-pw:checked) .aw-switch-on { display: none; }
body:has(#aw-pw:checked) .aw-switch-off { display: inline; }$aw$
WHERE owner = 'admin' AND name = 'netbird';

-- Organization fallbacks: used before the application object loads.
UPDATE organization SET
  logo = 'https://sso.example.com/brand/logo.png',
  favicon = 'https://sso.example.com/brand/favicon.png'
WHERE name = 'example-org';

COMMIT;
