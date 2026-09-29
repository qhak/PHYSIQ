const OLD_DOMAIN = 'callout-ai.com';
const CURRENT_DOMAIN = 'cutrank.app';
const OLD_VERIFICATION = '/google47e58fafcbf4ab45.html';

function redirect(url, status, preview) {
  const response = Response.redirect(url, status);
  return preview ? withPreviewNoindex(response) : response;
}

function withPreviewNoindex(response) {
  const result = new Response(response.body, response);
  result.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const preview = host.endsWith('.workers.dev');
    const pathname = url.pathname;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const response = await env.ASSETS.fetch(request);
      return preview ? withPreviewNoindex(response) : response;
    }

    if ((host === OLD_DOMAIN || host === `www.${OLD_DOMAIN}`) && pathname !== OLD_VERIFICATION) {
      url.hostname = CURRENT_DOMAIN;
      url.protocol = 'https:';
      return redirect(url, 301, preview);
    }

    if (host === `www.${CURRENT_DOMAIN}`) {
      url.hostname = CURRENT_DOMAIN;
      url.protocol = 'https:';
      return redirect(url, 301, preview);
    }

    const campaign = /^\/(t|i)([1-9]|1[0-5])$/.exec(pathname);
    if (campaign) {
      url.pathname = '/';
      url.searchParams.set('utm_source', `${campaign[1] === 't' ? 'tiktok' : 'instagram'}${campaign[2]}`);
      return redirect(url, 302, preview);
    }

    if (pathname === '/10' || pathname === '/100' || pathname === '/index.html') {
      url.pathname = '/';
      return redirect(url, 301, preview);
    }

    if (pathname === '/') {
      url.pathname = '/index.html';
      const response = await env.ASSETS.fetch(new Request(url, request));
      return preview ? withPreviewNoindex(response) : response;
    }

    // Keep the existing .html sitemap URLs canonical. Old extensionless links
    // get a permanent redirect only when the corresponding HTML file exists.
    if (!pathname.endsWith('/') && !pathname.split('/').at(-1).includes('.')) {
      const html = new URL(url);
      html.pathname += '.html';
      const matchingPage = await env.ASSETS.fetch(new Request(html, request));
      if (matchingPage.ok) return redirect(html, 301, preview);
    }

    const response = await env.ASSETS.fetch(request);
    return preview ? withPreviewNoindex(response) : response;
  },
};
