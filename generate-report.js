const fs = require('fs');
const path = require('path');

/**
 * Escapes a field for CSV export
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * Generates an interactive, modern, executive-ready HTML accessibility report
 * and a CSV export from saved axe-core JSON scan files.
 */
function generateAccessibilityReport(options = {}) {
  const reportsDir = options.reportsDir || path.join(process.cwd(), 'reports', 'accessibility');
  const outputHtmlFile = options.outputHtmlFile || path.join(reportsDir, 'accessibility-report.html');
  const outputCsvFile = options.outputCsvFile || path.join(reportsDir, 'accessibility-report.csv');

  if (!fs.existsSync(reportsDir)) {
    console.error(`Reports directory not found: ${reportsDir}`);
    return;
  }

  // Read all json files in reports/accessibility
  const jsonFiles = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json') && !f.startsWith('summary'));

  if (jsonFiles.length === 0) {
    console.log('No JSON scan files found in ' + reportsDir);
    return;
  }

  const rawScans = [];
  for (const file of jsonFiles) {
    try {
      const content = fs.readFileSync(path.join(reportsDir, file), 'utf-8');
      const data = JSON.parse(content);
      
      let scanName = file.replace(/-violations\.json$|\.json$/, '').replace(/-/g, ' ');
      scanName = scanName.replace(/\b\w/g, c => c.toUpperCase());
      
      if (Array.isArray(data)) {
        rawScans.push({
          scanName,
          fileName: file,
          url: 'https://broken-workshop.dequelabs.com/',
          timestamp: new Date().toISOString(),
          violations: data,
          passes: [],
          incomplete: [],
          inapplicable: [],
        });
      } else {
        rawScans.push({
          scanName: data.scanName || scanName,
          fileName: file,
          url: data.url || 'Unknown',
          timestamp: data.timestamp || new Date().toISOString(),
          violations: data.violations || [],
          passes: data.passes || [],
          incomplete: data.incomplete || [],
          inapplicable: data.inapplicable || [],
        });
      }
    } catch (err) {
      console.warn(`Error reading ${file}:`, err.message);
    }
  }

  // Deduplication & aggregation for Violations
  const uniqueViolationsMap = new Map();
  let totalRawViolationNodes = 0;
  let deduplicatedNodesCount = 0;

  for (const scan of rawScans) {
    for (const v of scan.violations) {
      if (!uniqueViolationsMap.has(v.id)) {
        uniqueViolationsMap.set(v.id, {
          id: v.id,
          impact: v.impact || 'minor',
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl,
          tags: v.tags || [],
          scans: new Set([scan.scanName]),
          nodesMap: new Map(),
        });
      }

      const ruleEntry = uniqueViolationsMap.get(v.id);
      ruleEntry.scans.add(scan.scanName);

      for (const node of (v.nodes || [])) {
        totalRawViolationNodes++;
        const targetKey = Array.isArray(node.target) ? node.target.join(' > ') : (node.target || '');
        const nodeKey = `${targetKey}:::${node.html || ''}`;

        if (ruleEntry.nodesMap.has(nodeKey)) {
          deduplicatedNodesCount++;
          const existingNode = ruleEntry.nodesMap.get(nodeKey);
          existingNode.scans.add(scan.scanName);
          existingNode.occurrences = (existingNode.occurrences || 1) + 1;
          if (!existingNode.screenshot && node.screenshot) {
            existingNode.screenshot = node.screenshot;
          }
        } else {
          ruleEntry.nodesMap.set(nodeKey, {
            target: node.target,
            targetString: targetKey,
            html: node.html,
            failureSummary: node.failureSummary,
            impact: node.impact || v.impact,
            scans: new Set([scan.scanName]),
            occurrences: 1,
            screenshot: node.screenshot || null,
          });
        }
      }
    }
  }

  const deduplicatedViolations = Array.from(uniqueViolationsMap.values()).map(v => ({
    ...v,
    scans: Array.from(v.scans),
    nodes: Array.from(v.nodesMap.values()).map(n => ({
      ...n,
      scans: Array.from(n.scans),
    })),
  }));

  // Deduplication & aggregation for Passes
  const uniquePassesMap = new Map();
  for (const scan of rawScans) {
    for (const p of scan.passes) {
      if (!uniquePassesMap.has(p.id)) {
        uniquePassesMap.set(p.id, {
          id: p.id,
          description: p.description,
          help: p.help,
          helpUrl: p.helpUrl,
          tags: p.tags || [],
          scans: new Set([scan.scanName]),
          totalNodes: 0,
        });
      }
      const passEntry = uniquePassesMap.get(p.id);
      passEntry.scans.add(scan.scanName);
      passEntry.totalNodes += (p.nodes ? p.nodes.length : 1);
    }
  }

  const deduplicatedPasses = Array.from(uniquePassesMap.values()).map(p => ({
    ...p,
    scans: Array.from(p.scans),
  }));

  // Impact Breakdown
  const impactCounts = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };

  for (const v of deduplicatedViolations) {
    const imp = (v.impact || 'minor').toLowerCase();
    if (impactCounts[imp] !== undefined) {
      impactCounts[imp]++;
    }
  }

  const totalUniqueFailingNodes = deduplicatedViolations.reduce((acc, v) => acc + v.nodes.length, 0);
  const totalEvaluatedRules = deduplicatedViolations.length + deduplicatedPasses.length;
  const complianceRate = totalEvaluatedRules > 0
    ? Math.round((deduplicatedPasses.length / totalEvaluatedRules) * 100)
    : 0;

  const allScanNames = Array.from(new Set(rawScans.map(s => s.scanName)));

  // ==========================================
  // 1. GENERATE CSV REPORT
  // ==========================================
  const csvHeaders = [
    'Type',
    'Rule ID',
    'Impact',
    'Rule Help',
    'Description',
    'WCAG Tags',
    'Found In Scans',
    'Occurrences (Pre-Dedup)',
    'Target Selector',
    'HTML Snippet',
    'Failure Summary',
    'Screenshot File',
    'Help URL'
  ];

  const csvRows = [csvHeaders.map(escapeCsv).join(',')];

  // Add violation rows
  for (const v of deduplicatedViolations) {
    for (const node of v.nodes) {
      csvRows.push([
        escapeCsv('Violation'),
        escapeCsv(v.id),
        escapeCsv(v.impact),
        escapeCsv(v.help),
        escapeCsv(v.description),
        escapeCsv(v.tags.join('; ')),
        escapeCsv(node.scans.join(', ')),
        escapeCsv(node.occurrences),
        escapeCsv(node.targetString),
        escapeCsv(node.html),
        escapeCsv(node.failureSummary || ''),
        escapeCsv(node.screenshot || 'N/A'),
        escapeCsv(v.helpUrl || '')
      ].join(','));
    }
  }

  // Add pass rows
  for (const p of deduplicatedPasses) {
    csvRows.push([
      escapeCsv('Pass'),
      escapeCsv(p.id),
      escapeCsv('Pass'),
      escapeCsv(p.help),
      escapeCsv(p.description),
      escapeCsv(p.tags.join('; ')),
      escapeCsv(p.scans.join(', ')),
      escapeCsv(p.totalNodes),
      escapeCsv('All matching elements passed'),
      escapeCsv('N/A'),
      escapeCsv('Passed validation'),
      escapeCsv('N/A'),
      escapeCsv(p.helpUrl || '')
    ].join(','));
  }

  const csvContent = csvRows.join('\r\n');
  fs.writeFileSync(outputCsvFile, csvContent, 'utf-8');
  console.log(`📊 CSV Report generated at:\n${outputCsvFile}`);

  // Base64 encode CSV for direct in-browser download
  const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');

  // ==========================================
  // 2. GENERATE MODERN PROFESSIONAL HTML REPORT (Clean, Crisp, Light Enterprise Palette)
  // ==========================================
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accessibility Audit Report - Deque axe-core & WCAG</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script>
    window.toggleCard = function(el) {
      const card = el ? el.closest('.violation-card') : null;
      if (card) card.classList.toggle('open');
    };

    window.toggleAllCards = function() {
      const cards = document.querySelectorAll('.violation-card');
      const someClosed = Array.from(cards).some(c => !c.classList.contains('open'));
      cards.forEach(c => {
        if (someClosed) c.classList.add('open');
        else c.classList.remove('open');
      });
    };

    window.openLightbox = function(src) {
      const modal = document.getElementById('lightboxModal');
      const img = document.getElementById('lightboxImg');
      if (modal && img) {
        img.src = src;
        modal.classList.add('active');
      }
    };

    window.closeLightbox = function() {
      const modal = document.getElementById('lightboxModal');
      if (modal) modal.classList.remove('active');
    };

    document.addEventListener('DOMContentLoaded', () => {
      document.addEventListener('click', function(e) {
        if (e.target.closest('a, button, .docs-btn, .help-link, .screenshot-img-wrap, .lightbox-modal')) {
          return;
        }
        const cardTop = e.target.closest('.card-top');
        if (cardTop) {
          window.toggleCard(cardTop);
        }
      });
    });
  </script>
  <style>
    :root {
      --bg-app: #f8fafc;
      --bg-card: #ffffff;
      --bg-card-subtle: #f1f5f9;
      --border-color: #e2e8f0;
      --border-darker: #cbd5e1;
      
      --text-heading: #0f172a;
      --text-body: #334155;
      --text-muted: #64748b;
      --text-light: #94a3b8;
      
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --primary-bg: #eef2ff;
      --primary-border: #c7d2fe;

      --critical: #dc2626;
      --critical-bg: #fef2f2;
      --critical-border: #fecaca;
      
      --serious: #ea580c;
      --serious-bg: #fff7ed;
      --serious-border: #ffedd5;
      
      --moderate: #d97706;
      --moderate-bg: #fffbeb;
      --moderate-border: #fef3c7;
      
      --minor: #2563eb;
      --minor-bg: #eff6ff;
      --minor-border: #dbeafe;
      
      --pass: #16a34a;
      --pass-bg: #f0fdf4;
      --pass-border: #bbf7d0;

      --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05);
      --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.07), 0 4px 6px -4px rgb(0 0 0 / 0.05);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg-app);
      color: var(--text-body);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* Top Navigation Bar */
    .top-nav {
      background: #ffffff;
      border-bottom: 1px solid var(--border-color);
      position: sticky;
      top: 0;
      z-index: 50;
      box-shadow: var(--shadow-sm);
    }

    .nav-inner {
      max-width: 1320px;
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      color: #ffffff;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 1.15rem;
      box-shadow: 0 4px 10px rgba(79, 70, 229, 0.3);
    }

    .brand-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-heading);
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      font-size: 0.85rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      border: 1px solid transparent;
    }

    .btn-csv {
      background: #16a34a;
      color: #ffffff;
      box-shadow: 0 2px 4px rgba(22, 163, 74, 0.2);
    }

    .btn-csv:hover {
      background: #15803d;
      transform: translateY(-1px);
    }

    .btn-print {
      background: #ffffff;
      border-color: var(--border-darker);
      color: var(--text-heading);
    }

    .btn-print:hover {
      background: var(--bg-card-subtle);
    }

    /* Main Container */
    .container {
      max-width: 1320px;
      margin: 0 auto;
      padding: 32px 24px 80px;
    }

    /* Hero Overview Card */
    .hero-card {
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 28px 32px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 24px;
    }

    .hero-info h1 {
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--text-heading);
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }

    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
      font-size: 0.875rem;
      color: var(--text-muted);
    }

    .meta-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .meta-tag svg {
      width: 16px;
      height: 16px;
      color: var(--text-light);
    }

    .dedup-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: #f0fdf4;
      border: 1px solid var(--pass-border);
      color: #15803d;
      border-radius: 999px;
      font-size: 0.85rem;
      font-weight: 600;
    }

    /* KPI Metrics Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }

    .kpi-card {
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 22px 24px;
      box-shadow: var(--shadow-sm);
      transition: all 0.2s ease;
      position: relative;
    }

    .kpi-card:hover {
      box-shadow: var(--shadow-md);
      transform: translateY(-2px);
    }

    .kpi-card.border-critical { border-left: 4px solid var(--critical); }
    .kpi-card.border-pass { border-left: 4px solid var(--pass); }
    .kpi-card.border-primary { border-left: 4px solid var(--primary); }
    .kpi-card.border-info { border-left: 4px solid #0284c7; }

    .kpi-label {
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .kpi-num {
      font-size: 2.25rem;
      font-weight: 800;
      color: var(--text-heading);
      line-height: 1.1;
      margin-bottom: 6px;
    }

    .kpi-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .impact-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .badge-pill {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
    }

    .badge-pill.critical { background: var(--critical-bg); color: var(--critical); border: 1px solid var(--critical-border); }
    .badge-pill.serious { background: var(--serious-bg); color: var(--serious); border: 1px solid var(--serious-border); }
    .badge-pill.moderate { background: var(--moderate-bg); color: var(--moderate); border: 1px solid var(--moderate-border); }
    .badge-pill.minor { background: var(--minor-bg); color: var(--minor); border: 1px solid var(--minor-border); }

    /* Filter Toolbar */
    .filter-bar {
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 16px 20px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .tab-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .tab-btn {
      background: #ffffff;
      color: var(--text-body);
      border: 1px solid var(--border-color);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 0.825rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .tab-btn:hover {
      background: var(--bg-card-subtle);
      border-color: var(--border-darker);
    }

    .tab-btn.active {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
      box-shadow: 0 2px 6px rgba(79, 70, 229, 0.25);
    }

    .search-input-wrap {
      position: relative;
      min-width: 260px;
    }

    .search-input {
      width: 100%;
      background: #ffffff;
      border: 1px solid var(--border-color);
      padding: 8px 14px 8px 36px;
      border-radius: 8px;
      font-size: 0.85rem;
      color: var(--text-heading);
      outline: none;
      transition: border-color 0.15s ease;
    }

    .search-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
    }

    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      width: 15px;
      height: 15px;
      color: var(--text-light);
      pointer-events: none;
    }

    .select-scan {
      background: #ffffff;
      border: 1px solid var(--border-color);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      color: var(--text-heading);
      outline: none;
      cursor: pointer;
    }

    /* Section Styling */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 32px 0 16px;
    }

    .section-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-heading);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .count-badge {
      font-size: 0.78rem;
      font-weight: 700;
      padding: 2px 10px;
      border-radius: 999px;
      background: var(--bg-card-subtle);
      color: var(--text-muted);
    }

    /* Cards Stack */
    .cards-stack {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .violation-card {
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: 12px;
      box-shadow: var(--shadow-sm);
      overflow: hidden;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .violation-card:hover {
      border-color: var(--border-darker);
      box-shadow: var(--shadow-md);
    }

    .violation-card.hidden {
      display: none !important;
    }

    .card-top {
      padding: 18px 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      cursor: pointer;
      user-select: none;
    }

    .rule-title-line {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }

    .impact-chip {
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 3px 10px;
      border-radius: 6px;
    }

    .impact-chip.critical { background: var(--critical-bg); color: var(--critical); border: 1px solid var(--critical-border); }
    .impact-chip.serious { background: var(--serious-bg); color: var(--serious); border: 1px solid var(--serious-border); }
    .impact-chip.moderate { background: var(--moderate-bg); color: var(--moderate); border: 1px solid var(--moderate-border); }
    .impact-chip.minor { background: var(--minor-bg); color: var(--minor); border: 1px solid var(--minor-border); }

    .rule-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-heading);
    }

    .elem-count-pill {
      font-size: 0.75rem;
      color: var(--text-muted);
      background: var(--bg-card-subtle);
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 600;
    }

    .scan-pill {
      font-size: 0.72rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--primary-bg);
      border: 1px solid var(--primary-border);
      color: var(--primary);
    }

    .rule-headline {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-heading);
      margin-bottom: 4px;
    }

    .rule-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 10px;
    }

    .tags-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }

    .wcag-chip {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      padding: 2px 7px;
      border-radius: 4px;
      background: var(--bg-card-subtle);
      color: var(--text-body);
      border: 1px solid var(--border-color);
    }

    .card-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .docs-btn {
      color: var(--primary);
      text-decoration: none;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 6px;
      background: var(--primary-bg);
      transition: background 0.15s ease;
      white-space: nowrap;
    }

    .docs-btn:hover {
      background: #e0e7ff;
    }

    .arrow-icon {
      width: 18px;
      height: 18px;
      color: var(--text-light);
      transition: transform 0.2s ease;
    }

    .violation-card.open .arrow-icon {
      transform: rotate(180deg);
    }

    .card-details {
      display: none;
      padding: 0 24px 24px;
      border-top: 1px solid var(--border-color);
      background: #fbfcfe;
    }

    .violation-card.open .card-details {
      display: block;
    }

    /* Node Details Block */
    .node-item {
      margin-top: 16px;
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 16px 18px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    }

    .node-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
      gap: 8px;
    }

    .selector-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      color: #9333ea;
      background: #faf5ff;
      border: 1px solid #f3e8ff;
      padding: 3px 8px;
      border-radius: 6px;
      word-break: break-all;
    }

    .dedup-tag {
      font-size: 0.72rem;
      font-weight: 700;
      color: #15803d;
      background: #f0fdf4;
      border: 1px solid var(--pass-border);
      padding: 2px 8px;
      border-radius: 6px;
    }

    .html-box {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      background: #0f172a;
      color: #f1f5f9;
      padding: 12px 14px;
      border-radius: 8px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin-bottom: 12px;
    }

    .remediation-box {
      font-size: 0.825rem;
      color: #991b1b;
      background: #fef2f2;
      border-left: 3px solid var(--critical);
      padding: 10px 14px;
      border-radius: 0 8px 8px 0;
      line-height: 1.5;
    }

    /* Pass Cards */
    .pass-row {
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      box-shadow: var(--shadow-sm);
      transition: all 0.15s ease;
    }

    .pass-row:hover {
      border-color: var(--pass-border);
    }

    .pass-badge {
      font-size: 0.72rem;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--pass-bg);
      color: var(--pass);
      border: 1px solid var(--pass-border);
    }

    /* Screenshot Visual Styles */
    .screenshot-card {
      margin-top: 14px;
      border: 1px solid var(--border-color);
      background: #f8fafc;
      border-radius: 10px;
      padding: 14px;
    }

    .screenshot-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 0.825rem;
      font-weight: 700;
      color: var(--text-heading);
      flex-wrap: wrap;
      gap: 8px;
    }

    .screenshot-highlight-tag {
      font-size: 0.72rem;
      font-weight: 700;
      color: #dc2626;
      background: #fef2f2;
      border: 1px solid #fecaca;
      padding: 2px 8px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .screenshot-img-wrap {
      display: inline-block;
      max-width: 100%;
      cursor: zoom-in;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-sm);
      transition: all 0.2s ease;
      background: #ffffff;
    }

    .screenshot-img-wrap:hover {
      box-shadow: var(--shadow-md);
      border-color: var(--primary);
    }

    .screenshot-img {
      display: block;
      max-width: 100%;
      max-height: 280px;
      object-fit: contain;
    }

    /* Lightbox Modal */
    .lightbox-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(4px);
      z-index: 9999;
      justify-content: center;
      align-items: center;
      padding: 30px;
    }

    .lightbox-modal.active {
      display: flex;
    }

    .lightbox-content {
      max-width: 90vw;
      max-height: 90vh;
      background: #ffffff;
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
      position: relative;
    }

    .lightbox-img {
      max-width: 100%;
      max-height: 82vh;
      display: block;
      border-radius: 8px;
    }

    .lightbox-close {
      position: absolute;
      top: -14px;
      right: -14px;
      width: 32px;
      height: 32px;
      background: #ffffff;
      border: 1px solid var(--border-darker);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-weight: 800;
      font-size: 16px;
      color: #0f172a;
      box-shadow: 0 4px 6px rgba(0,0,0,0.15);
    }

    @media print {
      .top-nav, .filter-bar, .btn { display: none !important; }
      body { background: #ffffff !important; }
      .violation-card { break-inside: avoid; border: 1px solid #ccc !important; }
      .card-details { display: block !important; }
    }
  </style>
</head>
<body>
  <!-- Top Navigation -->
  <nav class="top-nav">
    <div class="nav-inner">
      <div class="brand-wrap">
        <div class="brand-logo">A11y</div>
        <div>
          <div class="brand-title">Accessibility Compliance Dashboard</div>
        </div>
      </div>

      <div class="nav-actions">
        <!-- Direct CSV Download Button -->
        <a id="downloadCsvBtn" class="btn btn-csv" download="accessibility-report.csv" href="data:text/csv;base64,${csvBase64}">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
          Export CSV Report
        </a>
        <button class="btn btn-print" onclick="window.print()">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
          Print / PDF
        </button>
      </div>
    </div>
  </nav>

  <div class="container">
    <!-- Hero Card -->
    <div class="hero-card">
      <div class="hero-info">
        <h1>Accessibility Audit Report</h1>
        <div class="hero-meta">
          <span class="meta-tag">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
            <strong>Target:</strong> ${rawScans[0]?.url || 'Target Site'}
          </span>
          <span class="meta-tag">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            ${new Date().toLocaleString()}
          </span>
          <span class="meta-tag">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
            ${rawScans.length} Scans Included
          </span>
        </div>
      </div>

      <div>
        <span class="dedup-pill">
          <svg width="18" height="18" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg>
          Deduplication Active: ${deduplicatedNodesCount} duplicates merged
        </span>
      </div>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card border-critical">
        <div class="kpi-label">
          <span>Unique Violations</span>
          <span style="color: var(--critical); font-size: 1.1rem;">⚠️</span>
        </div>
        <div class="kpi-num" style="color: var(--critical);">${deduplicatedViolations.length}</div>
        <div class="kpi-desc">${totalUniqueFailingNodes} unique failing DOM elements</div>
        <div class="impact-badges">
          <span class="badge-pill critical">${impactCounts.critical} Critical</span>
          <span class="badge-pill serious">${impactCounts.serious} Serious</span>
          <span class="badge-pill moderate">${impactCounts.moderate} Mod</span>
          <span class="badge-pill minor">${impactCounts.minor} Minor</span>
        </div>
      </div>

      <div class="kpi-card border-pass">
        <div class="kpi-label">
          <span>Passed Validations</span>
          <span style="color: var(--pass); font-size: 1.1rem;">✓</span>
        </div>
        <div class="kpi-num" style="color: var(--pass);">${deduplicatedPasses.length}</div>
        <div class="kpi-desc">WCAG guidelines satisfied across scans</div>
      </div>

      <div class="kpi-card border-primary">
        <div class="kpi-label">
          <span>Compliance Score</span>
          <span style="color: var(--primary); font-size: 1.1rem;">🎯</span>
        </div>
        <div class="kpi-num" style="color: var(--primary);">${complianceRate}%</div>
        <div class="kpi-desc">${deduplicatedPasses.length} of ${totalEvaluatedRules} evaluated rules passed</div>
      </div>

      <div class="kpi-card border-info">
        <div class="kpi-label">
          <span>Multi-State Scans</span>
          <span style="color: #0284c7; font-size: 1.1rem;">📑</span>
        </div>
        <div class="kpi-num" style="color: #0284c7;">${rawScans.length}</div>
        <div class="kpi-desc">${deduplicatedNodesCount} duplicate instances eliminated</div>
      </div>
    </div>

    <!-- Toolbar Filters -->
    <div class="filter-bar">
      <div class="tab-pills">
        <button class="tab-btn active" data-filter="all">All (${deduplicatedViolations.length + deduplicatedPasses.length})</button>
        <button class="tab-btn" data-filter="violations">Violations (${deduplicatedViolations.length})</button>
        <button class="tab-btn" data-filter="passes">Passed (${deduplicatedPasses.length})</button>
        <button class="tab-btn" data-filter="critical">Critical (${impactCounts.critical})</button>
        <button class="tab-btn" data-filter="serious">Serious (${impactCounts.serious})</button>
        <button class="tab-btn" data-filter="moderate">Moderate (${impactCounts.moderate})</button>
        <button class="tab-btn" data-filter="minor">Minor (${impactCounts.minor})</button>
      </div>

      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <div class="search-input-wrap">
          <svg class="search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
          <input type="text" id="searchInput" class="search-input" placeholder="Search rules, selectors, tags...">
        </div>

        <select id="scanSelect" class="select-scan">
          <option value="all">All Scans</option>
          ${allScanNames.map(name => `<option value="${name}">${name}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- Violations Section -->
    <div id="violationsSection">
      <div class="section-header">
        <div class="section-title">
          <span>Accessibility Violations</span>
          <span class="count-badge">${deduplicatedViolations.length} unique rules</span>
          <button class="btn btn-print" style="padding: 4px 10px; font-size: 0.75rem; margin-left: 10px;" onclick="window.toggleAllCards()">Toggle All Cards</button>
        </div>
      </div>

      <div class="cards-stack">
        ${deduplicatedViolations.map((v, idx) => `
          <div class="violation-card open" data-impact="${v.impact}" data-scans="${v.scans.join(',')}" data-search="${v.id} ${v.help} ${v.description} ${v.tags.join(' ')} ${v.nodes.map(n => n.targetString).join(' ')}">
            <div class="card-top" onclick="window.toggleCard(this)">
              <div style="flex: 1;">
                <div class="rule-title-line">
                  <span class="impact-chip ${v.impact}">${v.impact}</span>
                  <span class="rule-code">${v.id}</span>
                  <span class="elem-count-pill">${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'}</span>
                  ${v.scans.map(s => `<span class="scan-pill">${s}</span>`).join('')}
                </div>
                <div class="rule-headline">${v.help}</div>
                <div class="rule-desc">${v.description}</div>
                <div class="tags-row">
                  ${v.tags.map(t => `<span class="wcag-chip">${t}</span>`).join('')}
                </div>
              </div>

              <div class="card-actions">
                ${v.helpUrl ? `<a href="${v.helpUrl}" target="_blank" rel="noopener" class="docs-btn" onclick="event.stopPropagation()">Axe Docs &rarr;</a>` : ''}
                <svg class="arrow-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
              </div>
            </div>

            <div class="card-details">
              ${v.nodes.map((node, nodeIdx) => `
                <div class="node-item">
                  <div class="node-top-bar">
                    <div>
                      <span class="selector-code">${node.targetString || 'Unknown Target'}</span>
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center;">
                      ${node.occurrences > 1 ? `<span class="dedup-tag">Seen in ${node.occurrences} scans</span>` : ''}
                      ${node.scans.map(s => `<span class="scan-pill">${s}</span>`).join('')}
                    </div>
                  </div>

                  ${node.html ? `<div class="html-box">${escapeHtml(node.html)}</div>` : ''}
                  ${node.failureSummary ? `<div class="remediation-box">${escapeHtml(node.failureSummary).replace(/\n/g, '<br>')}</div>` : ''}

                  ${node.screenshot ? `
                    <div class="screenshot-card">
                      <div class="screenshot-header">
                        <span style="display: inline-flex; align-items: center; gap: 6px;">
                          📷 <strong>Marked Violation Snapshot</strong>
                        </span>
                        <span class="screenshot-highlight-tag">
                          <span>🔴</span> Violated element marked in red
                        </span>
                      </div>
                      <div class="screenshot-img-wrap" onclick="openLightbox('${node.screenshot}')" title="Click to view full size">
                        <img src="${node.screenshot}" alt="Marked Accessibility Violation" class="screenshot-img" loading="lazy">
                      </div>
                    </div>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Passed Section -->
    <div id="passesSection" style="margin-top: 48px;">
      <div class="section-header">
        <div class="section-title">
          <span>Passed Validations</span>
          <span class="count-badge" style="background: var(--pass-bg); color: var(--pass);">${deduplicatedPasses.length} passed</span>
        </div>
      </div>

      <div class="cards-stack">
        ${deduplicatedPasses.map(p => `
          <div class="pass-row" data-scans="${p.scans.join(',')}" data-search="${p.id} ${p.help} ${p.description} ${p.tags.join(' ')}">
            <div style="flex: 1;">
              <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 4px; flex-wrap: wrap;">
                <span class="pass-badge">PASS</span>
                <span class="rule-code" style="color: #15803d;">${p.id}</span>
                ${p.scans.map(s => `<span class="scan-pill">${s}</span>`).join('')}
              </div>
              <div style="font-weight: 600; color: var(--text-heading); font-size: 0.95rem;">${p.help}</div>
              <div style="font-size: 0.85rem; color: var(--text-muted);">${p.description}</div>
              <div class="tags-row" style="margin-top: 8px;">
                ${p.tags.map(t => `<span class="wcag-chip">${t}</span>`).join('')}
              </div>
            </div>

            ${p.helpUrl ? `<a href="${p.helpUrl}" target="_blank" rel="noopener" class="docs-btn">Docs &rarr;</a>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  </div>

  <!-- Lightbox Modal for Screenshots -->
  <div id="lightboxModal" class="lightbox-modal" onclick="closeLightbox()">
    <div class="lightbox-content" onclick="event.stopPropagation()">
      <button class="lightbox-close" onclick="closeLightbox()">&times;</button>
      <img id="lightboxImg" src="" alt="Violation Full Snapshot" class="lightbox-img" />
    </div>
  </div>

  <script>
    function openLightbox(src) {
      const modal = document.getElementById('lightboxModal');
      const img = document.getElementById('lightboxImg');
      img.src = src;
      modal.classList.add('active');
    }

    function closeLightbox() {
      const modal = document.getElementById('lightboxModal');
      modal.classList.remove('active');
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    function toggleCard(topBar) {
      topBar.closest('.violation-card').classList.toggle('open');
    }

    let activeFilter = 'all';
    let searchQuery = '';
    let selectedScan = 'all';

    const tabBtns = document.querySelectorAll('.tab-btn');
    const searchInput = document.getElementById('searchInput');
    const scanSelect = document.getElementById('scanSelect');

    const violationsSection = document.getElementById('violationsSection');
    const passesSection = document.getElementById('passesSection');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        applyFilters();
      });
    });

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      applyFilters();
    });

    scanSelect.addEventListener('change', (e) => {
      selectedScan = e.target.value;
      applyFilters();
    });

    function applyFilters() {
      if (activeFilter === 'passes') {
        violationsSection.style.display = 'none';
        passesSection.style.display = 'block';
      } else if (['violations', 'critical', 'serious', 'moderate', 'minor'].includes(activeFilter)) {
        violationsSection.style.display = 'block';
        passesSection.style.display = 'none';
      } else {
        violationsSection.style.display = 'block';
        passesSection.style.display = 'block';
      }

      document.querySelectorAll('.violation-card').forEach(card => {
        const impact = card.dataset.impact;
        const scans = (card.dataset.scans || '').split(',');
        const searchText = (card.dataset.search || '').toLowerCase();

        let matchesFilter = true;
        if (activeFilter === 'passes') matchesFilter = false;
        else if (activeFilter !== 'all' && activeFilter !== 'violations') {
          matchesFilter = (impact === activeFilter);
        }

        let matchesScan = (selectedScan === 'all') || scans.includes(selectedScan);
        let matchesSearch = !searchQuery || searchText.includes(searchQuery);

        if (matchesFilter && matchesScan && matchesSearch) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });

      document.querySelectorAll('.pass-row').forEach(card => {
        const scans = (card.dataset.scans || '').split(',');
        const searchText = (card.dataset.search || '').toLowerCase();

        let matchesFilter = (activeFilter === 'all' || activeFilter === 'passes');
        let matchesScan = (selectedScan === 'all') || scans.includes(selectedScan);
        let matchesSearch = !searchQuery || searchText.includes(searchQuery);

        if (matchesFilter && matchesScan && matchesSearch) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(outputHtmlFile, html, 'utf-8');
  console.log(`\n🎉 Accessibility HTML report successfully generated at:\n${outputHtmlFile}\n`);
  return { htmlFile: outputHtmlFile, csvFile: outputCsvFile };
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { generateAccessibilityReport };

// If run directly via CLI: node generate-report.js
if (require.main === module || (process.argv[1] && process.argv[1].endsWith('generate-report.js'))) {
  generateAccessibilityReport();
}

