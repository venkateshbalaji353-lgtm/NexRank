
import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_HTML_SIZE = 2_000_000;
const TIMEOUT_MS = 10_000;
const MAX_LINKS_TO_CHECK = 20;
const LINK_TIMEOUT_MS = 4_000;

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 88 && c === 99)
  );
}

function isPrivateIPv6(ip) {
  const address = ip.toLowerCase();

  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address) ||
    address.startsWith("::ffff:")
  );
}

function isPrivateAddress(address) {
  const version = isIP(address);

  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);

  return true;
}

function normalizeUrl(value) {
  let input = String(value || "").trim();

  if (!input || input.length > 2048) {
    throw new Error("Enter a valid website URL.");
  }

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid website URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Custom ports are not supported.");
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata.google"
  ) {
    throw new Error("This hostname is not allowed.");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private IP addresses cannot be audited.");
    }
  } else if (
    !hostname.includes(".") ||
    hostname.split(".").some((part) => !part)
  ) {
    throw new Error("Enter a valid public domain name.");
  }

  return url;
}

async function validatePublicHost(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private IP addresses cannot be audited.");
    }
    return;
  }

  let addresses;

  try {
    addresses = await lookup(hostname, {
      all: true,
      verbatim: true,
    });
  } catch {
    throw new Error("The website domain could not be resolved.");
  }

  if (
    !addresses.length ||
    addresses.some((entry) => isPrivateAddress(entry.address))
  ) {
    throw new Error("This domain resolves to a restricted IP address.");
  }
}

function safeUrl(value, baseUrl) {
  if (!value) return null;

  try {
    const parsed = new URL(value, baseUrl);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    if (parsed.username || parsed.password) {
      return null;
    }

    if (parsed.port && !["80", "443"].includes(parsed.port)) {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

async function fetchWebsite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    await validatePublicHost(url);

    const response = await fetch(url.href, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": "NexRankSEOAudit/0.3",
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      throw new Error(`The website returned HTTP ${response.status}.`);
    }

    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error("The URL did not return an HTML webpage.");
    }

    const declaredLength = Number(
      response.headers.get("content-length") || 0
    );

    if (declaredLength > MAX_HTML_SIZE) {
      throw new Error("The webpage is too large to audit.");
    }

    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Could not read the webpage response.");
    }

    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        totalBytes += value.byteLength;

        if (totalBytes > MAX_HTML_SIZE) {
          await reader.cancel();
          throw new Error("The webpage is too large to audit.");
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return {
      html: new TextDecoder("utf-8").decode(bytes),
      status: response.status,
      finalUrl: url.href,
      contentType,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSingleLink(linkUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(linkUrl);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Unsupported protocol.");
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new Error("Credentials are not allowed.");
    }

    if (parsedUrl.port && !["80", "443"].includes(parsedUrl.port)) {
      throw new Error("Custom ports are not allowed.");
    }

    await validatePublicHost(parsedUrl);
  } catch {
    return {
      url: linkUrl,
      status: "unknown",
      httpStatus: null,
      detail: "Could not safely verify this link.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LINK_TIMEOUT_MS
  );

  try {
    const response = await fetch(parsedUrl.href, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "NexRankSEOAudit/0.3",
      },
      cache: "no-store",
    });

    const httpStatus = response.status;
    await response.body?.cancel().catch(() => {});

    if (httpStatus === 404 || httpStatus === 410) {
      return {
        url: linkUrl,
        status: "broken",
        httpStatus,
        detail: `HTTP ${httpStatus}: page not found or gone.`,
      };
    }

    if (httpStatus >= 500 && httpStatus <= 599) {
      return {
        url: linkUrl,
        status: "server_error",
        httpStatus,
        detail: `HTTP ${httpStatus}: server error; retry may be needed.`,
      };
    }

    if (httpStatus === 403 || httpStatus === 429) {
      return {
        url: linkUrl,
        status: "unknown",
        httpStatus,
        detail: `HTTP ${httpStatus}: access denied or rate limited.`,
      };
    }

    if (httpStatus >= 200 && httpStatus < 300) {
      return {
        url: linkUrl,
        status: "working",
        httpStatus,
        detail: `HTTP ${httpStatus}: link responded successfully.`,
      };
    }

    if (httpStatus >= 300 && httpStatus < 400) {
      return {
        url: linkUrl,
        status: "unknown",
        httpStatus,
        detail: `HTTP ${httpStatus}: redirect detected; destination not followed.`,
      };
    }

    if (httpStatus >= 400 && httpStatus < 500) {
      return {
        url: linkUrl,
        status: "broken",
        httpStatus,
        detail: `HTTP ${httpStatus}: client error.`,
      };
    }

    return {
      url: linkUrl,
      status: "unknown",
      httpStatus,
      detail: `HTTP ${httpStatus}: status could not be classified.`,
    };
  } catch (error) {
    return {
      url: linkUrl,
      status: "unknown",
      httpStatus: null,
      detail:
        error?.name === "AbortError"
          ? "Request timed out."
          : "Request failed or was blocked; link status is unconfirmed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkLinks(linkUrls) {
  const uniqueUrls = [...new Set(linkUrls)]
    .filter(Boolean)
    .slice(0, MAX_LINKS_TO_CHECK);

  const results = [];

  for (let i = 0; i < uniqueUrls.length; i += 4) {
    const batch = uniqueUrls.slice(i, i + 4);
    const batchResults = await Promise.all(
      batch.map((url) => checkSingleLink(url))
    );
    results.push(...batchResults);
  }

  return {
    checked: results.length,
    limit: MAX_LINKS_TO_CHECK,
    broken: results.filter((item) => item.status === "broken").length,
    serverErrors: results.filter(
      (item) => item.status === "server_error"
    ).length,
    working: results.filter((item) => item.status === "working").length,
    unknown: results.filter((item) => item.status === "unknown").length,
    results,
  };
}

async function buildAudit(html, pageUrl, status, contentType) {
  const $ = cheerio.load(html);

  const titleCount = $("title").length;
  const title = $("title").first().text().trim();

  const descriptionTags = $('meta[name="description"]');
  const descriptionCount = descriptionTags.length;
  const description =
    descriptionTags.first().attr("content")?.trim() || "";

  const robots =
    $('meta[name="robots"]').first().attr("content")?.trim() || null;

  const canonicalTags = $('link[rel~="canonical"]');
  const canonicalCount = canonicalTags.length;
  const canonical = safeUrl(
    canonicalTags.first().attr("href"),
    pageUrl
  );

  const headings = {
    h1: $("h1").length,
    h2: $("h2").length,
    h3: $("h3").length,
    h4: $("h4").length,
    h5: $("h5").length,
    h6: $("h6").length,
  };

  const headingOrderIssues = [];
  let previousHeadingLevel = 0;

  $("h1, h2, h3, h4, h5, h6").each((_, element) => {
    const level = Number(element.tagName.substring(1));

    if (previousHeadingLevel > 0 && level > previousHeadingLevel + 1) {
      headingOrderIssues.push({
        from: previousHeadingLevel,
        to: level,
      });
    }

    previousHeadingLevel = level;
  });

  const images = $("img").toArray();
  const missingAlt = images.filter(
    (image) => !$(image).attr("alt")?.trim()
  ).length;

  const links = $("a[href]").toArray();
  const baseHostname = new URL(pageUrl).hostname;

  let internalLinks = 0;
  let externalLinks = 0;
  let invalidLinks = 0;
  let emptyLinkText = 0;
  const linkUrls = [];

  for (const link of links) {
    const $link = $(link);
    const href = safeUrl($link.attr("href"), pageUrl);

    if (!href) {
      invalidLinks++;
    } else {
      linkUrls.push(href);

      try {
        if (new URL(href).hostname === baseHostname) {
          internalLinks++;
        } else {
          externalLinks++;
        }
      } catch {
        invalidLinks++;
      }
    }

    const visibleText = $link.text().trim();
    const ariaLabel = $link.attr("aria-label")?.trim();
    const imageAlt = $link.find("img[alt]").toArray().some(
      (image) => Boolean($(image).attr("alt")?.trim())
    );

    if (!visibleText && !ariaLabel && !imageAlt) {
      emptyLinkText++;
    }
  }

  const viewport = $('meta[name="viewport"]').attr("content");
  const robotsBlocksIndexing = /\bnoindex\b/i.test(robots || "");

  const linkAudit = await checkLinks(linkUrls);
  const checks = [];

  function addCheck(name, passed, detail, points) {
    checks.push({
      name,
      status: passed ? "pass" : "warning",
      detail,
      points,
    });
  }

  addCheck(
    "HTML response",
    status >= 200 && status < 300,
    `HTTP status ${status}`,
    10
  );

  addCheck(
    "Title tag",
    Boolean(title),
    title ? `${title.length} characters` : "No title tag was found.",
    15
  );

  addCheck(
    "Duplicate title tags",
    titleCount <= 1,
    `${titleCount} title tag(s) found; use one title tag per page.`,
    5
  );

  addCheck(
    "Title length",
    title.length >= 30 && title.length <= 60,
    title
      ? `${title.length} characters; a common target is 30–60.`
      : "Add a descriptive title.",
    5
  );

  addCheck(
    "Meta description",
    Boolean(description),
    description
      ? `${description.length} characters`
      : "No meta description was found.",
    15
  );

  addCheck(
    "Duplicate meta descriptions",
    descriptionCount <= 1,
    `${descriptionCount} meta description tag(s) found.`,
    5
  );

  addCheck(
    "Meta description length",
    description.length >= 70 && description.length <= 160,
    description
      ? `${description.length} characters; a common target is 70–160.`
      : "Add a useful page description.",
    5
  );

  addCheck(
    "H1 heading",
    headings.h1 === 1,
    `${headings.h1} H1 heading(s) found.`,
    10
  );

  addCheck(
    "Heading structure",
    headings.h2 > 0,
    `${headings.h2} H2 heading(s) found.`,
    5
  );

  addCheck(
    "Heading hierarchy",
    headingOrderIssues.length === 0,
    headingOrderIssues.length === 0
      ? "No skipped heading levels were detected."
      : `${headingOrderIssues.length} skipped heading level(s) detected.`,
    5
  );

  addCheck(
    "Image alt text",
    missingAlt === 0,
    images.length
      ? `${missingAlt} of ${images.length} images have missing or empty alt text.`
      : "No images were found.",
    10
  );

  addCheck(
    "Canonical URL",
    Boolean(canonical),
    canonical
      ? "A canonical URL was found."
      : "No valid canonical URL was found.",
    10
  );

  addCheck(
    "Canonical tag count",
    canonicalCount === 1,
    `${canonicalCount} canonical tag(s) found; normally use one canonical tag.`,
    5
  );

  addCheck(
    "Robots meta",
    !robotsBlocksIndexing,
    robotsBlocksIndexing
      ? "The robots meta tag contains noindex."
      : robots
        ? `Robots directive: ${robots}`
        : "No robots meta tag was found.",
    10
  );

  addCheck(
    "Mobile viewport",
    Boolean(viewport),
    viewport
      ? "A viewport meta tag was found."
      : "Add a responsive viewport meta tag.",
    5
  );

  addCheck(
    "Internal links",
    internalLinks > 0,
    `${internalLinks} internal link(s) found.`,
    5
  );

  addCheck(
    "Descriptive link text",
    emptyLinkText === 0,
    `${emptyLinkText} link(s) have no visible text, accessible label, or image alt text.`,
    5
  );

  addCheck(
    "Valid link URLs",
    invalidLinks === 0,
    `${invalidLinks} link(s) use unsupported or invalid URL formats.`,
    5
  );

  addCheck(
    "Broken links",
    linkAudit.broken === 0 && linkAudit.serverErrors === 0,
    `${linkAudit.broken} broken link(s); ${linkAudit.serverErrors} server error(s); ${linkAudit.unknown} unconfirmed link(s) among ${linkAudit.checked} checked.`,
    5
  );

  const totalPoints = checks.reduce(
    (sum, check) => sum + check.points,
    0
  );

  const earnedPoints = checks.reduce(
    (sum, check) =>
      sum + (check.status === "pass" ? check.points : 0),
    0
  );

  return {
    url: pageUrl,
    httpStatus: status,
    contentType,
    score: Math.round((earnedPoints / totalPoints) * 100),

    title: title || null,
    titleLength: title.length,
    titleCount,

    description: description || null,
    descriptionLength: description.length,
    descriptionCount,

    canonical,
    canonicalCount,
    robots,

    headings,
    headingOrderIssues,

    images: {
      total: images.length,
      missingAlt,
    },

    links: {
      total: links.length,
      internal: internalLinks,
      external: externalLinks,
      invalid: invalidLinks,
      emptyText: emptyLinkText,
      broken: linkAudit.broken,
      working: linkAudit.working,
      serverErrors: linkAudit.serverErrors,
      unknown: linkAudit.unknown,
      checked: linkAudit.checked,
      checkLimit: linkAudit.limit,
      brokenLinkDetails: linkAudit.results,
    },

    checks,

    note:
      "This is a starter on-page audit, not a Google ranking prediction. Link checking is limited to 20 unique URLs and uses HEAD requests. Some websites block HEAD requests, so unknown results are not necessarily broken links.",
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const url = normalizeUrl(body?.url);
    const result = await fetchWebsite(url);

    const audit = await buildAudit(
      result.html,
      result.finalUrl,
      result.status,
      result.contentType
    );

    return NextResponse.json(audit);
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "The website took too long to respond."
        : error?.message || "The audit could not be completed.";

    const status =
      message.includes("not allowed") ||
      message.includes("Private IP") ||
      message.includes("credentials") ||
      message.includes("Custom ports") ||
      message.includes("valid public") ||
      message.includes("restricted IP")
        ? 400
        : 422;

    return NextResponse.json({ error: message }, { status });
  }
}
