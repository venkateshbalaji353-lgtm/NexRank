
"use client";

import { useEffect, useState } from "react";

const HISTORY_KEY = "nexrank-audit-history";
const MAX_HISTORY = 10;

const recommendationTips = {
  "HTML response":
    "Check the server response and fix any HTTP errors before continuing.",
  "Title tag":
    "Add a unique, descriptive title tag that explains the page's main topic.",
  "Title length":
    "Review the title and aim for a concise, descriptive title around 30–60 characters.",
  "Duplicate title tags":
    "Use one clear title tag for the page.",
  "Meta description":
    "Write a unique meta description that summarizes the page and encourages relevant clicks.",
  "Duplicate meta descriptions":
    "Keep one relevant meta description for the page.",
  "Meta description length":
    "Review the description and aim for a useful, concise summary, often around 70–160 characters.",
  "H1 heading":
    "Use a clear primary heading that describes the main topic.",
  "Heading structure":
    "Add descriptive H2 headings to organize the content.",
  "Heading hierarchy":
    "Review heading levels and make sure the structure is logical.",
  "Image alt text":
    "Add meaningful alt text to informative images. Use empty alt text for decorative images.",
  "Canonical URL":
    "Check whether the page needs a valid canonical URL.",
  "Canonical tag count":
    "Use one appropriate canonical URL for the page.",
  "Robots meta":
    "Review the robots directive and confirm whether search engines should index this page.",
  "Mobile viewport":
    "Add a responsive viewport meta tag to support mobile layouts.",
  "Internal links":
    "Add relevant internal links to help visitors and crawlers discover related pages.",
  "Descriptive link text":
    "Give links descriptive text or an accessible label.",
  "Valid link URLs":
    "Review invalid link URLs and update them to valid HTTP or HTTPS URLs.",
  "Broken links":
    "Review URLs flagged as broken and update, remove, or redirect them. Verify server errors and unknown results separately.",
};

function getLinkStatusLabel(status) {
  const labels = {
    working: "Working",
    broken: "Broken",
    server_error: "Server Error",
    unknown: "Unknown",
  };

  return labels[status] || "Unknown";
}

function getLinkStatusColor(status) {
  if (status === "working") return [30, 125, 85];

  if (status === "broken" || status === "server_error") {
    return [185, 55, 55];
  }

  return [185, 105, 25];
}

function formatAuditDate(date) {
  try {
    return new Date(date).toLocaleString("en-IN");
  } catch {
    return "Date unavailable";
  }
}

function normalizeAuditUrl(value) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}`.toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  }
}

function buildScoreComparisons(items) {
  const grouped = new Map();

  for (const item of items) {
    const key = normalizeAuditUrl(item.url || item.audit?.url);

    if (!key || !Number.isFinite(Number(item.score))) continue;

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(item);
  }

  return Array.from(grouped.entries())
    .filter(([, audits]) => audits.length >= 2)
    .map(([key, audits]) => {
      const latest = audits[0];
      const previous = audits[1];
      const difference = Number(latest.score) - Number(previous.score);

      return {
        key,
        url: latest.url || latest.audit?.url || key,
        latest,
        previous,
        difference,
        status:
          difference > 0
            ? "Improved"
            : difference < 0
              ? "Decreased"
              : "Unchanged",
      };
    });
}

function readAuditHistory() {
  try {
    const saved = window.localStorage.getItem(HISTORY_KEY);

    if (!saved) return [];

    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item) =>
        item &&
        item.id &&
        item.audit &&
        typeof item.audit === "object"
    );
  } catch (error) {
    console.warn("Could not load audit history:", error);
    return [];
  }
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [linkFilter, setLinkFilter] = useState("all");
  const [history, setHistory] = useState([]);

  useEffect(() => {
    setHistory(readAuditHistory());
  }, []);

  function saveAuditToHistory(auditData) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      auditedAt: new Date().toISOString(),
      url: auditData.url,
      score: auditData.score,
      title: auditData.title || "",
      httpStatus: auditData.httpStatus,
      audit: auditData,
    };

    try {
      const existing = readAuditHistory();
      const updated = [item, ...existing].slice(0, MAX_HISTORY);

      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      setHistory(updated);
    } catch (error) {
      console.warn("Could not save audit history:", error);

      setError(
        "Audit completed, but browser storage could not save the history. You can still view the current audit."
      );
    }
  }

  function openHistoryItem(item) {
    if (!item?.audit) return;

    setAudit(item.audit);
    setUrl(item.url || item.audit.url || "");
    setError("");
    setLinkFilter("all");

    window.setTimeout(() => {
      document.getElementById("audit-results")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 100);
  }

  function clearAuditHistory() {
    const confirmed = window.confirm(
      "Clear all saved SEO audit history from this browser?"
    );

    if (!confirmed) return;

    try {
      window.localStorage.removeItem(HISTORY_KEY);
      setHistory([]);
    } catch (error) {
      console.warn("Could not clear audit history:", error);
      setError("Could not clear saved history. Please try again.");
    }
  }

  async function handleAudit(event) {
    event.preventDefault();

    if (!url.trim()) {
      setError("Please enter a website URL.");
      return;
    }

    setLoading(true);
    setError("");
    setAudit(null);
    setLinkFilter("all");

    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "SEO audit failed.");
      }

      setAudit(data);
      saveAuditToHistory(data);

      window.setTimeout(() => {
        document.getElementById("audit-results")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 100);
    } catch (err) {
      setError(err.message || "Unable to audit this website.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDownloadPDF() {
    if (!audit || pdfLoading) return;

    setPdfLoading(true);

    try {
      const { jsPDF } = await import("jspdf");

      const doc = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });

      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 18;
      const contentWidth = pageWidth - margin * 2;
      const footerY = pageHeight - 12;
      const bottomLimit = pageHeight - 22;

      let y = 53;
      let logoDataUrl = null;

      // Load NexRank logo.
      try {
        const logoResponse = await fetch("/nexrank-logo.png", {
          cache: "no-store",
        });

        if (logoResponse.ok) {
          const logoBlob = await logoResponse.blob();
          const objectUrl = URL.createObjectURL(logoBlob);

          try {
            logoDataUrl = await new Promise((resolve, reject) => {
              const image = new Image();

              image.onload = () => {
                try {
                  const canvas = document.createElement("canvas");
                  canvas.width = image.naturalWidth;
                  canvas.height = image.naturalHeight;

                  const context = canvas.getContext("2d");

                  if (!context) {
                    reject(new Error("Could not create image canvas."));
                    return;
                  }

                  context.drawImage(image, 0, 0);
                  resolve(canvas.toDataURL("image/png"));
                } catch (err) {
                  reject(err);
                }
              };

              image.onerror = () =>
                reject(new Error("Could not load the NexRank logo."));

              image.src = objectUrl;
            });
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        } else {
          console.warn("NexRank logo request failed:", logoResponse.status);
        }
      } catch (logoError) {
        console.warn("Logo unavailable; continuing without it.", logoError);
      }

      function drawHeader(firstPage = false) {
        doc.setFillColor(17, 24, 39);
        doc.rect(0, 0, pageWidth, 42, "F");

        if (logoDataUrl) {
          try {
            const info = doc.getImageProperties(logoDataUrl);
            const maxWidth = firstPage ? 42 : 30;
            const maxHeight = firstPage ? 26 : 18;

            const scale = Math.min(
              maxWidth / info.width,
              maxHeight / info.height
            );

            const logoWidth = info.width * scale;
            const logoHeight = info.height * scale;

            doc.addImage(
              logoDataUrl,
              "PNG",
              margin,
              (42 - logoHeight) / 2,
              logoWidth,
              logoHeight
            );
          } catch (err) {
            console.warn("Could not add logo to PDF:", err);
          }
        }

        const titleX = margin + 49;

        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(firstPage ? 15 : 12);

        doc.text(
          firstPage ? "SEO AUDIT REPORT" : "SEO AUDIT REPORT - CONTINUED",
          titleX,
          17
        );

        doc.setTextColor(212, 175, 55);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.text("WEBSITE PERFORMANCE OVERVIEW", titleX, 24);

        doc.setTextColor(220, 225, 235);
        doc.setFontSize(8);

        doc.text(
          `Generated: ${new Date().toLocaleDateString("en-IN")}`,
          titleX,
          32
        );
      }

      function drawFooter() {
        const pageCount = doc.internal.getNumberOfPages();

        for (let page = 1; page <= pageCount; page++) {
          doc.setPage(page);

          doc.setDrawColor(225, 229, 235);
          doc.line(margin, footerY - 5, pageWidth - margin, footerY - 5);

          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(125, 135, 150);

          doc.text("NexRank | Starter SEO Audit", margin, footerY);

          doc.text(
            `${page} / ${pageCount}`,
            pageWidth - margin,
            footerY,
            { align: "right" }
          );
        }
      }

      function addNewPage() {
        doc.addPage();
        drawHeader(false);
        y = 53;
      }

      function ensureSpace(height) {
        if (y + height > bottomLimit) {
          addNewPage();
        }
      }

      function addText(text, options = {}) {
        const {
          size = 10,
          bold = false,
          color = [65, 75, 95],
          gap = 5,
        } = options;

        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(size);
        doc.setTextColor(...color);

        const lines = doc.splitTextToSize(
          String(text ?? ""),
          contentWidth
        );

        const lineHeight = size * 0.45;
        const requiredHeight = lines.length * lineHeight + gap;

        ensureSpace(requiredHeight);
        doc.text(lines, margin, y);
        y += requiredHeight;
      }

      // First page header.
      drawHeader(true);

      addText("Website overview", {
        size: 16,
        bold: true,
        color: [25, 39, 65],
        gap: 8,
      });

      addText(`Website: ${audit.url}`);
      addText(`HTTP status: ${audit.httpStatus}`);

      addText(`SEO health score: ${audit.score}/100`, {
        size: 14,
        bold: true,
        color: [35, 91, 210],
        gap: 9,
      });

      addText("Page metadata", {
        size: 13,
        bold: true,
        color: [25, 39, 65],
        gap: 6,
      });

      addText(`Page title: ${audit.title || "Not found"}`);
      addText(`Title length: ${audit.titleLength} characters`);
      addText(`Meta description: ${audit.description || "Not found"}`);
      addText(`Description length: ${audit.descriptionLength} characters`);
      addText(`Canonical URL: ${audit.canonical || "Not found"}`);
      addText(`Robots directive: ${audit.robots || "Not specified"}`);

      addText("Content and links", {
        size: 13,
        bold: true,
        color: [25, 39, 65],
        gap: 6,
      });

      addText(
        `Headings: H1 ${audit.headings.h1}, H2 ${audit.headings.h2}, H3 ${audit.headings.h3}`
      );

      addText(
        `Images missing alt text: ${audit.images.missingAlt} of ${audit.images.total}`
      );

      addText(
        `Links: ${audit.links.total} total, ${audit.links.internal} internal, ${audit.links.external ?? 0} external`
      );

      // Broken link report.
      const linkDetails = audit.links.brokenLinkDetails || [];

      addText("Broken link checker", {
        size: 13,
        bold: true,
        color: [25, 39, 65],
        gap: 5,
      });

      addText(
        `Checked: ${audit.links.checked ?? linkDetails.length} of up to ${audit.links.checkLimit ?? 20} links | Working: ${audit.links.working ?? 0} | Broken: ${audit.links.broken ?? 0} | Server errors: ${audit.links.serverErrors ?? 0} | Unknown: ${audit.links.unknown ?? 0}`,
        { size: 9, gap: 4 }
      );

      for (const link of linkDetails) {
        const statusLabel = getLinkStatusLabel(link.status);

        addText(
          `${statusLabel}${link.httpStatus ? ` (HTTP ${link.httpStatus})` : ""}`,
          {
            size: 9,
            bold: true,
            color: getLinkStatusColor(link.status),
            gap: 1,
          }
        );

        addText(link.url, { size: 8, gap: 1 });

        addText(link.detail || "No additional details.", {
          size: 8,
          color: [90, 100, 115],
          gap: 4,
        });
      }

      addText("Audit checks", {
        size: 14,
        bold: true,
        color: [25, 39, 65],
        gap: 7,
      });

      for (const check of audit.checks) {
        const passed = check.status === "pass";

        addText(`${passed ? "PASS" : "REVIEW"} - ${check.name}`, {
          size: 10,
          bold: true,
          color: passed ? [30, 125, 85] : [185, 105, 25],
          gap: 2,
        });

        addText(check.detail, {
          size: 9,
          color: [90, 100, 115],
          gap: 5,
        });
      }

      const failedChecks = audit.checks.filter(
        (check) => check.status !== "pass"
      );

      addText("Recommended next steps", {
        size: 14,
        bold: true,
        color: [25, 39, 65],
        gap: 7,
      });

      if (failedChecks.length === 0) {
        addText(
          "No flagged issues were found in the checks performed. This starter audit does not cover every SEO factor."
        );
      }

      for (const check of failedChecks) {
        addText(check.name, {
          size: 10,
          bold: true,
          color: [185, 105, 25],
          gap: 2,
        });

        addText(
          recommendationTips[check.name] ||
            "Review this finding and investigate the reported issue.",
          { size: 9, gap: 6 }
        );
      }

      addText(audit.note || "Starter on-page SEO audit.", {
        size: 8,
        color: [110, 120, 135],
        gap: 4,
      });

      drawFooter();

      let hostname = "website";

      try {
        hostname = new URL(audit.url).hostname.replace(
          /[^a-z0-9.-]/gi,
          "_"
        );
      } catch {
        // Use the default filename.
      }

      doc.save(`NexRank-SEO-Audit-${hostname}.pdf`);
    } catch (err) {
      console.error("PDF export failed:", err);

      window.alert(
        "Could not generate the PDF. Check that jspdf is installed, then try again."
      );
    } finally {
      setPdfLoading(false);
    }
  }

  const failedChecks =
    audit?.checks?.filter((check) => check.status !== "pass") || [];

  const linkDetails = audit?.links?.brokenLinkDetails || [];

  const filteredLinks = linkDetails.filter(
    (link) => linkFilter === "all" || link.status === linkFilter
  );

  const scoreComparisons = buildScoreComparisons(history);

  return (
    <main className="site">
      <nav className="navbar">
        <a href="/" className="brand">
          <span className="brand-icon">N</span>
          <span>
            Nex<span className="brand-light">Rank</span>
          </span>
        </a>

        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#audit" className="nav-button">
            Free SEO Audit ↗
          </a>
        </div>
      </nav>

      <section className="hero" id="audit">
        <div className="hero-content">
          <div className="eyebrow">
            <span className="status-dot" />
            WEBSITE SEO AUDIT TOOL
          </div>

          <h1>
            Make your website
            <br />
            <span>rank better.</span>
          </h1>

          <p className="hero-description">
            Discover SEO issues, understand what is holding your
            website back, and get actionable recommendations
            to improve your search visibility.
          </p>

          <form className="audit-form" onSubmit={handleAudit}>
            <span className="url-icon">↗</span>

            <input
              type="text"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Enter your website URL"
              aria-label="Website URL"
              aria-describedby={error ? "audit-error" : undefined}
              autoComplete="url"
              required
            />

            <button type="submit" disabled={loading}>
              {loading ? "Analyzing..." : "Analyze website →"}
            </button>
          </form>

          <p className="form-note">
            Free starter audit <span>·</span> On-page SEO checks
            <span>·</span> Actionable insights
          </p>

          {error && (
            <p className="error-message" id="audit-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="preview">
          <div className="preview-top">
            <div className="window-dots">
              <i />
              <i />
              <i />
            </div>

            <span>nexrank / overview</span>

            <span className="live-label">
              ● {loading ? "Scanning" : "Live preview"}
            </span>
          </div>

          <div className="preview-body">
            <p className="preview-caption">YOUR WEBSITE HEALTH</p>

            <div className="score-layout">
              <div className="score-circle">
                <div>
                  <strong>{audit ? audit.score : "--"}</strong>
                  <small> / 100</small>
                </div>
              </div>

              <div className="score-info">
                <strong>SEO audit report</strong>

                <p>
                  {loading
                    ? "Checking your webpage..."
                    : audit
                      ? audit.title || audit.url
                      : "Enter a URL to get started."}
                </p>

                <span className="neutral-pill">
                  {loading
                    ? "Please wait"
                    : audit
                      ? `HTTP ${audit.httpStatus}`
                      : "Awaiting analysis"}
                </span>
              </div>
            </div>

            <div className="preview-divider" />
            <p className="checks-title">AUDIT CHECKS</p>

            {audit ? (
              audit.checks.map((check) => (
                <div className="check-row" key={check.name}>
                  <span>{check.status === "pass" ? "✓" : "!"}</span>
                  <div>
                    <strong>{check.name}</strong>
                    <small>{check.detail}</small>
                  </div>
                  <b>{check.status === "pass" ? "Pass" : "Review"}</b>
                </div>
              ))
            ) : (
              <>
                <div className="check-row">
                  <span>◈</span>
                  <div>
                    <strong>Page metadata</strong>
                    <small>Title and description</small>
                  </div>
                  <b>—</b>
                </div>

                <div className="check-row">
                  <span>⌘</span>
                  <div>
                    <strong>Content structure</strong>
                    <small>Headings and hierarchy</small>
                  </div>
                  <b>—</b>
                </div>

                <div className="check-row">
                  <span>▧</span>
                  <div>
                    <strong>Technical SEO</strong>
                    <small>Canonical and crawl signals</small>
                  </div>
                  <b>—</b>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* SEO AUDIT HISTORY AND SCORE COMPARISON */}
      {history.length > 0 && (
        <section className="features" id="audit-history">
          <div className="section-heading">
            <span>SAVED REPORTS</span>
            <h2>SEO audit history</h2>
            <p>
              Your 10 most recent audits saved in this browser.
              Clearing this browser's site data may remove the history.
            </p>
          </div>

          {scoreComparisons.length > 0 && (
            <div className="recommendations" style={{ marginBottom: "24px" }}>
              <div className="section-heading">
                <span>SEO PROGRESS</span>
                <h2>Score comparison</h2>
                <p>
                  Compare the two most recent saved audits for each website.
                  This tracks NexRank audit scores, not Google rankings.
                </p>
              </div>

              <div className="feature-grid">
                {scoreComparisons.map((comparison) => {
                  const improved = comparison.difference > 0;
                  const decreased = comparison.difference < 0;

                  const changeColor = improved
                    ? "#16845b"
                    : decreased
                      ? "#c24141"
                      : "#64748b";

                  const changeText =
                    comparison.difference > 0
                      ? `+${comparison.difference} points`
                      : comparison.difference < 0
                        ? `${comparison.difference} points`
                        : "No change";

                  return (
                    <article className="feature-card" key={comparison.key}>
                      <div className="feature-icon">↗</div>

                      <h3 style={{ overflowWrap: "anywhere" }}>
                        {comparison.url}
                      </h3>

                      <p>
                        <strong>Previous score:</strong>{" "}
                        {comparison.previous.score}/100
                      </p>

                      <p>
                        <strong>Latest score:</strong>{" "}
                        {comparison.latest.score}/100
                      </p>

                      <p>
                        <strong>Score change:</strong>{" "}
                        <span style={{ color: changeColor, fontWeight: 700 }}>
                          {changeText}
                        </span>
                      </p>

                      <span
                        className="neutral-pill"
                        style={{ color: changeColor }}
                      >
                        {comparison.status}
                      </span>

                      <p>
                        <small>
                          Previous:{" "}
                          {formatAuditDate(comparison.previous.auditedAt)}
                        </small>
                      </p>

                      <p>
                        <small>
                          Latest:{" "}
                          {formatAuditDate(comparison.latest.auditedAt)}
                        </small>
                      </p>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          <div className="feature-grid">
            {history.map((item) => (
              <article className="feature-card" key={item.id}>
                <div className="feature-icon">↺</div>

                <h3 style={{ overflowWrap: "anywhere" }}>
                  {item.title || item.url}
                </h3>

                <p style={{ overflowWrap: "anywhere" }}>{item.url}</p>

                <p>
                  <strong>SEO score:</strong> {item.score}/100
                </p>

                <p>
                  <strong>HTTP status:</strong> {item.httpStatus ?? "Unknown"}
                </p>

                <p>
                  <strong>Audited:</strong>{" "}
                  {formatAuditDate(item.auditedAt)}
                </p>

                <button
                  type="button"
                  className="nav-button"
                  onClick={() => openHistoryItem(item)}
                >
                  View report
                </button>
              </article>
            ))}
          </div>

          <div className="pdf-download">
            <button
              type="button"
              className="nav-button"
              onClick={clearAuditHistory}
            >
              Clear history
            </button>
          </div>
        </section>
      )}

      {audit && (
        <section className="features" id="audit-results">
          <div className="section-heading">
            <span>YOUR RESULTS</span>
            <h2>SEO audit findings</h2>
            <p>Results for {audit.url}</p>
          </div>

          <div className="feature-grid">
            <article className="feature-card">
              <div className="feature-icon">T</div>
              <h3>Page title</h3>
              <p>{audit.title || "No title found."}</p>
              <p>{audit.titleLength} characters</p>
            </article>

            <article className="feature-card">
              <div className="feature-icon">D</div>
              <h3>Meta description</h3>
              <p>{audit.description || "No meta description found."}</p>
              <p>{audit.descriptionLength} characters</p>
            </article>

            <article className="feature-card">
              <div className="feature-icon">H</div>
              <h3>Headings and images</h3>
              <p>H1 headings: {audit.headings?.h1 ?? 0}</p>
              <p>
                Images missing alt text: {audit.images.missingAlt} of{" "}
                {audit.images.total}
              </p>
            </article>
          </div>

          {/* BROKEN LINK CHECKER */}
          <div className="recommendations">
            <div className="section-heading">
              <span>LINK HEALTH</span>
              <h2>Broken link checker</h2>
              <p>
                Checked {audit.links.checked ?? linkDetails.length} of up to{" "}
                {audit.links.checkLimit ?? 20} unique links found on this page.
                Unknown links may be blocked or timed out; they are not
                automatically broken.
              </p>
            </div>

            <div className="feature-grid">
              <article className="feature-card">
                <div className="feature-icon">✓</div>
                <h3>Working</h3>
                <p>{audit.links.working ?? 0} links</p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">!</div>
                <h3>Broken</h3>
                <p>{audit.links.broken ?? 0} links</p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">↻</div>
                <h3>Server errors</h3>
                <p>{audit.links.serverErrors ?? 0} links</p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">?</div>
                <h3>Unknown</h3>
                <p>{audit.links.unknown ?? 0} links</p>
              </article>
            </div>

            <div
              className="link-filter-controls"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                margin: "18px 0",
              }}
            >
              {[
                ["all", "All links"],
                ["working", "Working"],
                ["broken", "Broken"],
                ["server_error", "Server errors"],
                ["unknown", "Unknown"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="nav-button"
                  aria-pressed={linkFilter === value}
                  onClick={() => setLinkFilter(value)}
                  style={{
                    opacity: linkFilter === value ? 1 : 0.7,
                    outline:
                      linkFilter === value ? "2px solid #2563eb" : "none",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {linkDetails.length > 0 ? (
              <div className="feature-grid">
                {filteredLinks.map((link, index) => (
                  <article
                    className="feature-card"
                    key={`${link.url}-${index}`}
                  >
                    <span className="neutral-pill">
                      {getLinkStatusLabel(link.status)}
                      {link.httpStatus ? ` · HTTP ${link.httpStatus}` : ""}
                    </span>

                    <h3 style={{ overflowWrap: "anywhere" }}>
                      {link.url}
                    </h3>

                    <p>{link.detail || "No additional details."}</p>

                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      Open link ↗
                    </a>
                  </article>
                ))}

                {filteredLinks.length === 0 && (
                  <article className="feature-card">
                    <h3>No matching links</h3>
                    <p>There are no links in this status category.</p>
                  </article>
                )}
              </div>
            ) : (
              <article className="feature-card">
                <h3>No link details available</h3>
                <p>Run a new audit to check links on this page.</p>
              </article>
            )}
          </div>

          <p className="audit-note">{audit.note}</p>

          <div className="pdf-download">
            <button
              type="button"
              className="nav-button"
              onClick={handleDownloadPDF}
              disabled={pdfLoading}
            >
              {pdfLoading ? "Preparing PDF..." : "Download PDF Report ↓"}
            </button>
          </div>

          <div className="recommendations">
            <div className="section-heading">
              <span>YOUR ACTION PLAN</span>
              <h2>Recommended next steps</h2>
              <p>
                Review the flagged checks and prioritize the improvements
                relevant to your website.
              </p>
            </div>

            {failedChecks.length > 0 ? (
              <div className="feature-grid">
                {failedChecks.map((check) => (
                  <article
                    className="feature-card recommendation-card"
                    key={check.name}
                  >
                    <div className="feature-icon">!</div>
                    <h3>{check.name}</h3>
                    <p>{check.detail}</p>

                    <p>
                      <strong>What to do</strong>
                    </p>

                    <p>
                      {recommendationTips[check.name] ||
                        "Review this finding and investigate the reported issue."}
                    </p>

                    <span className="neutral-pill">Needs review</span>
                  </article>
                ))}
              </div>
            ) : (
              <article className="feature-card">
                <div className="feature-icon">✓</div>
                <h3>No flagged issues</h3>
                <p>
                  All checks in this starter audit passed. Continue monitoring
                  your website and review other SEO factors that this audit
                  does not cover.
                </p>
              </article>
            )}
          </div>
        </section>
      )}

      <section className="features" id="features">
        <div className="section-heading">
          <span>BUILT FOR BETTER WEBSITES</span>
          <h2>Know what to improve.</h2>
          <p>
            Clear insights that help you take the next step with confidence.
          </p>
        </div>

        <div className="feature-grid">
          <article className="feature-card">
            <div className="feature-icon">◎</div>
            <h3>SEO health checks</h3>
            <p>
              Identify missing metadata, heading issues, and other on-page SEO
              signals.
            </p>
          </article>

          <article className="feature-card">
            <div className="feature-icon">↗</div>
            <h3>Actionable insights</h3>
            <p>
              Understand detected issues and learn what to fix first.
            </p>
          </article>

          <article className="feature-card">
            <div className="feature-icon">▤</div>
            <h3>Simple audit report</h3>
            <p>View findings in a clear, organized report.</p>
          </article>
        </div>
      </section>

      <section className="how-section" id="how-it-works">
        <span>GET STARTED IN THREE STEPS</span>
        <h2>From URL to insights.</h2>

        <div className="steps">
          <div>
            <b>01</b>
            <strong>Enter your URL</strong>
            <p>Add the website you want to review.</p>
          </div>

          <div>
            <b>02</b>
            <strong>Run an audit</strong>
            <p>Check supported SEO elements.</p>
          </div>

          <div>
            <b>03</b>
            <strong>Review findings</strong>
            <p>Prioritize improvements for your website.</p>
          </div>
        </div>
      </section>

      <footer>
        <a href="/" className="brand">
          <span className="brand-icon">N</span>
          <span>
            Nex<span className="brand-light">Rank</span>
          </span>
        </a>

        <p>Practical SEO insights for a better web.</p>
        <small>© 2026 NexRank. All rights reserved.</small>
      </footer>
    </main>
  );
}
