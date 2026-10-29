
import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMEOUT_MS = 10000;
const MAX_HTML_SIZE = 2_000_000;
const MAX_LINKS_TO_CHECK = 20;
const LINK_TIMEOUT_MS = 4000;
const USER_AGENT = "NexRankSEOAudit/0.5";

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);

  if (
    p.length !== 4 ||
    p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }

  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split("%")[0];

  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
}

function isPrivateAddress(ip) {
  const version = isIP(ip);

  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);

  return true;
}

function validateUrl(value, baseUrl) {
  let url;

  try {
    url = baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch {
    throw new Error("Please enter a valid website URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing usernames or passwords are not allowed.");
  }

  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Custom ports are not allowed.");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Local and internal hosts cannot be audited.");
  }

  if (isIP(host) && isPrivateAddress(host)) {
    throw new Error("Private or restricted IP addresses cannot be audited.");
  }

  if (
    !isIP(host) &&
    (!host.includes(".") || host.startsWith(".") || host.endsWith("."))
  ) {
    throw new Error("Please enter a public website domain.");
  }

  return url;
}

async function validatePublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error("Private or restricted IP addresses cannot be accessed.");
    }

    return;
  }

  let records;

  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("The website domain could not be resolved.");
  }

  if (
    !records.length ||
    records.some((record) => isPrivateAddress(record.address))
  ) {
    throw new Error(
      "The website resolves to a private or restricted address and cannot be audited."
    );
  }
}

async function fetchWithTimeout(url, options = {}, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWebsite(url) {
  await validatePublicHost(url);

  let response;

  try {
    response = await fetchWithTimeout(
      url.href,
      {
        redirect: "error",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      },
      TIMEOUT_MS
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("The website took too long to respond.");
    }

    throw new Error(
      "Could not fetch this website. Check the URL and try again. Redirecting URLs may need their final destination URL."
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(`Website returned HTTP ${response.status}.`);
  }

  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("The URL did not return an HTML page.");
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > MAX_HTML_SIZE) {
    throw new Error("The page is too large to audit (maximum 2 MB).");
  }

  const html = await response.text();

  if (html.length > MAX_HTML_SIZE) {
    throw new Error("The page is too large to audit (maximum 2 MB).");
  }

  return {
    html,
    status: response.status,
    contentType,
  };
}

async function checkSingleLink(linkUrl) {
  try {
    const url = validateUrl(linkUrl);
    await validatePublicHost(url);

    const response = await fetchWithTimeout(
      url.href,
      {
        method: "HEAD",
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
        },
      },
      LINK_TIMEOUT_MS
    );

    const status = response.status;
    let state = "unknown";

    if (status >= 200 && status < 300) {
      state = "working";
    } else if (
      status === 404 ||
      status === 410 ||
      (status >= 400 && status < 500 && status !== 403 && status !== 429)
    ) {
      state = "broken";
    } else if (status >= 500) {
      state = "server_error";
    } else if (status >= 300 && status < 400) {
      state = "redirect";
    }

    const messages = {
      working: "Responded successfully",
      broken: "Page not found or client error",
      server_error: "Server error",
      redirect: "Redirect response detected; destination not followed",
      unknown: "Could not confirm link status",
    };

    await response.body?.cancel().catch(() => {});

    return {
      url: url.href,
      status,
      state,
      message: messages[state],
    };
  } catch (error) {
    return {
      url: linkUrl,
      status: null,
      state: "unknown",
      message:
        error?.name === "AbortError"
          ? "Request timed out"
          : error?.message || "Could not check this link",
    };
  }
}

async function checkLinks(linkUrls) {
  const uniqueUrls = [...new Set(linkUrls)]
    .filter(Boolean)
    .slice(0, MAX_LINKS_TO_CHECK);

  const results = [];

  for (let i = 0; i < uniqueUrls.length; i += 4) {
    const batch = await Promise.all(
      uniqueUrls.slice(i, i + 4).map(checkSingleLink)
    );

    results.push(...batch);
  }

  return {
    checked: results.length,
    working: results.filter((item) => item.state === "working").length,
    broken: results.filter((item) => item.state === "broken").length,
    serverErrors: results.filter((item) => item.state === "server_error").length,
    redirects: results.filter((item) => item.state === "redirect").length,
    unknown: results.filter(
      (item) => item.state === "unknown" || item.state === "redirect"
    ).length,
    results,
  };
}

async function fetchTextResource(url) {
  try {
    await validatePublicHost(url);

    const response = await fetchWithTimeout(
      url.href,
      {
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/plain,application/xml,text/xml,*/*",
        },
      },
      5000
    );

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: response.status,
        text: "",
      };
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: response.status,
        text: "",
      };
    }

    const text = await response.text();

    return {
      ok: true,
      status: response.status,
      text: text.slice(0, 500_000),
    };
  } catch {
    return {
      ok: false,
      status: null,
      text: "",
    };
  }
}

async function checkRobotsAndSitemap(pageUrl) {
  const origin = pageUrl.origin;
  const robotsUrl = new URL("/robots.txt", origin);
  const sitemapUrl = new URL("/sitemap.xml", origin);

  const [robots, sitemap] = await Promise.all([
    fetchTextResource(robotsUrl),
    fetchTextResource(sitemapUrl),
  ]);

  const robotsExists = robots.ok;
  const sitemapExists =
    sitemap.ok && /<urlset\b|<sitemapindex\b/i.test(sitemap.text);

  const robotsMentionsSitemap =
    robotsExists && /^\s*Sitemap\s*:/im.test(robots.text);

  const sitemapLocCount = sitemapExists
    ? (sitemap.text.match(/<loc>/gi) || []).length
    : 0;

  return {
    robots: {
      url: robotsUrl.href,
      exists: robotsExists,
      status: robots.status,
      mentionsSitemap: robotsMentionsSitemap,
      disallowAll:
        robotsExists && /^\s*Disallow\s*:\s*\/\s*$/im.test(robots.text),
    },
    sitemap: {
      url: sitemapUrl.href,
      exists: sitemapExists,
      status: sitemap.status,
      urlCount: sitemapLocCount,
    },
  };
}

function severityFor(check) {
  if (check.passed) return "Low";

  const criticalChecks = [
    "Page responds with successful HTTP status",
    "Page has a title",
    "Page has a meta description",
    "Page has exactly one H1",
    "Robots meta does not block indexing",
  ];

  const highChecks = [
    "Title length is recommended",
    "Meta description length is recommended",
    "Canonical URL is present",
    "Images have alt text",
    "Mobile viewport is configured",
    "Structured data is valid",
  ];

  const mediumChecks = [
    "Heading hierarchy is logical",
    "Links use descriptive text",
    "Robots.txt is available",
    "XML sitemap is available",
    "Broken links were not detected",
  ];

  if (criticalChecks.includes(check.name)) return "Critical";
  if (highChecks.includes(check.name)) return "High";
  if (mediumChecks.includes(check.name)) return "Medium";

  return "Low";
}

function categoryFor(name) {
  if (/title|meta description|canonical|robots meta/i.test(name)) {
    return "Metadata";
  }

  if (/H1|H2|heading|image|structured data/i.test(name)) {
    return "Content";
  }

  if (/HTTP|viewport|robots\.txt|sitemap|indexing/i.test(name)) {
    return "Technical SEO";
  }

  return "Links";
}

function addCheck(checks, name, passed, points, detail, category) {
  checks.push({
    name,
    passed,
    status: passed ? "pass" : "review",
    points,
    detail,
    category: category || categoryFor(name),
  });
}

async function buildAudit(html, pageUrl, status, contentType) {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();
  const titleCount = $("title").length;

  const descriptionTags = $('meta[name="description"]');
  const description = (
    descriptionTags.first().attr("content") || ""
  ).trim();

  const robots = (
    $('meta[name="robots"]').attr("content") || ""
  ).toLowerCase();

  const canonicalTags = $('link[rel~="canonical"]');
  const rawCanonical = canonicalTags.first().attr("href") || "";

  let canonical = "";

  if (rawCanonical) {
    try {
      canonical = new URL(rawCanonical, pageUrl).href;
    } catch {
      canonical = rawCanonical;
    }
  }

  const h1s = $("h1")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const h2s = $("h2")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const h3s = $("h3")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const headingLevels = $("h1,h2,h3,h4,h5,h6")
    .map((_, el) => Number(el.tagName.slice(1)))
    .get();

  let headingHierarchyOk = true;
  let previousLevel = 0;

  for (const level of headingLevels) {
    if (previousLevel && level > previousLevel + 1) {
      headingHierarchyOk = false;
    }

    previousLevel = level;
  }

  const images = $("img")
    .map((_, el) => ({
      src: $(el).attr("src") || "",
      alt: ($(el).attr("alt") || "").trim(),
    }))
    .get();

  const imagesMissingAlt = images.filter((img) => !img.alt).length;

  const allLinks = $("a[href]")
    .map((_, el) => ({
      href: $(el).attr("href") || "",
      text: $(el).text().trim(),
      aria: ($(el).attr("aria-label") || "").trim(),
      hasImage: $(el).find("img").length > 0,
    }))
    .get();

  let internalLinks = 0;
  let externalLinks = 0;
  let invalidLinks = 0;
  let emptyTextLinks = 0;

  const linksToCheck = [];

  for (const link of allLinks) {
    try {
      const parsed = new URL(link.href, pageUrl);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        continue;
      }

      if (parsed.origin === pageUrl.origin) {
        internalLinks++;
      } else {
        externalLinks++;
      }

      if (!link.text && !link.aria && !link.hasImage) {
        emptyTextLinks++;
      }

      if (
        !parsed.hash &&
        !linksToCheck.includes(parsed.href) &&
        linksToCheck.length < MAX_LINKS_TO_CHECK
      ) {
        linksToCheck.push(parsed.href);
      }
    } catch {
      invalidLinks++;
    }
  }

  const jsonLdScripts = $('script[type="application/ld+json"]');
  let schemaValid = true;
  const schemaErrors = [];

  jsonLdScripts.each((index, element) => {
    try {
      JSON.parse($(element).contents().text());
    } catch {
      schemaValid = false;
      schemaErrors.push(
        `JSON-LD block ${index + 1} contains invalid JSON`
      );
    }
  });

  const [resourceChecks, linkAudit] = await Promise.all([
    checkRobotsAndSitemap(pageUrl),
    checkLinks(linksToCheck),
  ]);

  const checks = [];

  addCheck(
    checks,
    "Page responds with successful HTTP status",
    status >= 200 && status < 300,
    10,
    `HTTP ${status}`,
    "Technical SEO"
  );

  addCheck(
    checks,
    "Page has a title",
    Boolean(title),
    10,
    title || "No title tag found",
    "Metadata"
  );

  addCheck(
    checks,
    "Title length is recommended",
    title.length >= 30 && title.length <= 60,
    5,
    `Title length: ${title.length} characters (recommended 30–60)`,
    "Metadata"
  );

  addCheck(
    checks,
    "Page has a meta description",
    Boolean(description),
    10,
    description || "No meta description found",
    "Metadata"
  );

  addCheck(
    checks,
    "Meta description length is recommended",
    description.length >= 70 && description.length <= 160,
    5,
    `Description length: ${description.length} characters (recommended 70–160)`,
    "Metadata"
  );

  addCheck(
    checks,
    "Page has exactly one H1",
    h1s.length === 1,
    10,
    `Found ${h1s.length} H1 heading(s)`,
    "Content"
  );

  addCheck(
    checks,
    "Page uses H2 headings",
    h2s.length > 0,
    5,
    `Found ${h2s.length} H2 heading(s)`,
    "Content"
  );

  addCheck(
    checks,
    "Heading hierarchy is logical",
    headingHierarchyOk,
    5,
    headingHierarchyOk
      ? "No skipped heading levels detected"
      : "One or more heading levels are skipped",
    "Content"
  );

  addCheck(
    checks,
    "Images have alt text",
    imagesMissingAlt === 0,
    10,
    `${imagesMissingAlt} of ${images.length} image(s) missing alt text`,
    "Content"
  );

  addCheck(
    checks,
    "Canonical URL is present",
    Boolean(canonical),
    5,
    canonical || "No canonical link found",
    "Metadata"
  );

  addCheck(
    checks,
    "Page has one canonical URL",
    canonicalTags.length === 1,
    3,
    `Found ${canonicalTags.length} canonical tag(s)`,
    "Technical SEO"
  );

  addCheck(
    checks,
    "Robots meta does not block indexing",
    !/(^|[,\s])noindex([,\s]|$)/i.test(robots),
    8,
    robots
      ? `Robots meta: ${robots}`
      : "No robots meta tag (default indexing behavior applies)",
    "Technical SEO"
  );

  addCheck(
    checks,
    "Mobile viewport is configured",
    Boolean($('meta[name="viewport"]').attr("content")),
    5,
    $('meta[name="viewport"]').attr("content") ||
      "No viewport meta tag found",
    "Technical SEO"
  );

  addCheck(
    checks,
    "Page has internal links",
    internalLinks > 0,
    4,
    `${internalLinks} internal link(s)`,
    "Links"
  );

  addCheck(
    checks,
    "Links use descriptive text",
    emptyTextLinks === 0,
    5,
    `${emptyTextLinks} link(s) with no accessible text`,
    "Links"
  );

  addCheck(
    checks,
    "Links have valid URL syntax",
    invalidLinks === 0,
    5,
    `${invalidLinks} invalid link URL(s)`,
    "Links"
  );

  addCheck(
    checks,
    "Broken links were not detected",
    linkAudit.broken === 0,
    5,
    `${linkAudit.broken} broken link(s) among ${linkAudit.checked} checked`,
    "Links"
  );

  addCheck(
    checks,
    "Robots.txt is available",
    resourceChecks.robots.exists,
    3,
    resourceChecks.robots.exists
      ? `Found robots.txt (HTTP ${resourceChecks.robots.status})`
      : "robots.txt not found or unavailable",
    "Technical SEO"
  );

  addCheck(
    checks,
    "XML sitemap is available",
    resourceChecks.sitemap.exists,
    3,
    resourceChecks.sitemap.exists
      ? `Found sitemap with ${resourceChecks.sitemap.urlCount} <loc> entries`
      : "sitemap.xml not found or not recognized as an XML sitemap",
    "Technical SEO"
  );

  addCheck(
    checks,
    "Structured data is valid",
    schemaValid,
    4,
    jsonLdScripts.length
      ? schemaValid
        ? `${jsonLdScripts.length} JSON-LD block(s) parsed successfully; this checks JSON syntax only`
        : schemaErrors.join("; ")
      : "No JSON-LD structured data found",
    "Content"
  );

  for (const check of checks) {
    check.severity = severityFor(check);
  }

  const totalPoints = checks.reduce(
    (sum, check) => sum + check.points,
    0
  );

  const earnedPoints = checks.reduce(
    (sum, check) => sum + (check.passed ? check.points : 0),
    0
  );

  const score = Math.round((earnedPoints / totalPoints) * 100);

  const categories = [
    "Metadata",
    "Content",
    "Technical SEO",
    "Links",
  ];

  const scoreBreakdown = categories.map((category) => {
    const items = checks.filter(
      (check) => check.category === category
    );

    const possible = items.reduce(
      (sum, check) => sum + check.points,
      0
    );

    const earned = items.reduce(
      (sum, check) => sum + (check.passed ? check.points : 0),
      0
    );

    return {
      category,
      score: possible
        ? Math.round((earned / possible) * 100)
        : 0,
      earnedPoints: earned,
      totalPoints: possible,
      passed: items.filter((item) => item.passed).length,
      totalChecks: items.length,
    };
  });

  const failedChecks = checks.filter((check) => !check.passed);

  return {
    url: pageUrl.href,
    httpStatus: status,
    contentType,
    score,
    scoreBreakdown,

    title,
    titleLength: title.length,
    titleCount,
    titleTagCount: titleCount,

    description,
    descriptionLength: description.length,
    descriptionCount: $("meta[name='description']").length,

    canonical,
    canonicalCount: canonicalTags.length,
    robots,

    h1s,
    h2s,
    h3s,
    headingCount: headingLevels.length,

    headings: {
      h1: h1s.length,
      h2: h2s.length,
      h3: h3s.length,
    },

    images: {
      total: images.length,
      missingAlt: imagesMissingAlt,
      details: images.slice(0, 50),
    },

    links: {
      total: allLinks.length,
      internal: internalLinks,
      external: externalLinks,
      invalid: invalidLinks,
      emptyText: emptyTextLinks,
      checked: linkAudit.checked,
      checkLimit: MAX_LINKS_TO_CHECK,
      working: linkAudit.working,
      broken: linkAudit.broken,
      serverErrors: linkAudit.serverErrors,
      redirects: linkAudit.redirects,
      unknown: linkAudit.unknown,

      // Include all checked URLs so the UI filters can show every status.
      brokenLinkDetails: linkAudit.results.map((item) => ({
        url: item.url,
        status:
          item.state === "redirect" ? "unknown" : item.state,
        httpStatus: item.status,
        detail: item.message,
      })),
    },

    robotsFile: resourceChecks.robots,
    robotsInfo: resourceChecks.robots,
    sitemap: resourceChecks.sitemap,

    structuredData: {
      jsonLdBlocks: jsonLdScripts.length,
      validJson: schemaValid,
      errors: schemaErrors,
    },

    checks,

    summary: {
      passed: checks.filter((check) => check.passed).length,
      failed: failedChecks.length,
      critical: failedChecks.filter(
        (check) => check.severity === "Critical"
      ).length,
      high: failedChecks.filter(
        (check) => check.severity === "High"
      ).length,
      medium: failedChecks.filter(
        (check) => check.severity === "Medium"
      ).length,
      low: failedChecks.filter(
        (check) => check.severity === "Low"
      ).length,
    },

    note:
      "NexRank Starter SEO Audit checks common on-page and technical signals. It is not a Google ranking prediction. Structured data validation checks JSON syntax, not Google's full rich-result eligibility rules. Link checks are limited to a sample of up to 20 unique links. Some servers block HEAD requests, so some statuses may be unknown.",
  };
}

export async function POST(request) {
  try {
    const body = await request.json();

    if (!body?.url || typeof body.url !== "string") {
      return NextResponse.json(
        { error: "Please enter a website URL." },
        { status: 400 }
      );
    }

    const url = validateUrl(body.url.trim());
    const { html, status, contentType } = await fetchWebsite(url);

    const result = await buildAudit(
      html,
      url,
      status,
      contentType
    );

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error?.message || "Audit failed. Please try again.";

    const clientError =
      /please enter|only HTTP|not allowed|private|internal|custom ports|public website|valid website/i.test(
        message
      );

    return NextResponse.json(
      { error: message },
      { status: clientError ? 400 : 422 }
    );
  }
}
