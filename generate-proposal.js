const { chromium } = require('@playwright/test');
const path = require('path');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CRM Project Proposal - $600 AUD Plan</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
    
    :root {
      --primary: #4F46E5;
      --primary-hover: #4338CA;
      --secondary: #10B981;
      --dark: #0F172A;
      --light: #F8FAFC;
      --border: #E2E8F0;
      --text: #334155;
      --text-muted: #64748B;
      --card-bg: #FFFFFF;
      --highlight: #F59E0B;
    }
    
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      color: var(--text);
      background-color: var(--light);
      margin: 0;
      padding: 0;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
    }
    
    .page {
      max-width: 800px;
      margin: 0 auto;
      background: var(--card-bg);
      padding: 30px 40px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
      border-radius: 8px;
      position: relative;
    }

    .accent-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%);
      border-top-left-radius: 8px;
      border-top-right-radius: 8px;
    }
    
    .header {
      border-bottom: 2px solid var(--border);
      padding-bottom: 20px;
      margin-top: 10px;
      margin-bottom: 25px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo-area h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 26px;
      font-weight: 700;
      color: var(--dark);
      margin: 0;
      letter-spacing: -0.02em;
    }
    
    .logo-area span {
      color: var(--primary);
    }
    
    .proposal-tag {
      background-color: rgba(79, 70, 229, 0.1);
      color: var(--primary);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .intro-msg {
      background-color: #F8FAFC;
      border: 1px solid var(--border);
      border-left: 4px solid var(--primary);
      padding: 18px;
      border-radius: 0 8px 8px 0;
      margin-bottom: 30px;
      font-size: 14px;
      color: var(--dark);
      line-height: 1.6;
    }

    .intro-label {
      font-weight: 700;
      text-transform: uppercase;
      font-size: 11px;
      color: var(--primary);
      letter-spacing: 0.05em;
      margin-bottom: 6px;
      display: block;
    }
    
    h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
      color: var(--dark);
      margin-top: 25px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .section-icon {
      color: var(--primary);
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 25px;
    }
    
    .feature-card {
      border: 1px solid var(--border);
      padding: 15px;
      border-radius: 8px;
      background-color: #FCFDFE;
    }
    
    .feature-card h3 {
      margin-top: 0;
      margin-bottom: 6px;
      font-size: 14.5px;
      color: var(--dark);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .feature-card p {
      margin: 0;
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.45;
    }
    
    .tech-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 25px;
    }
    
    .badge {
      background-color: #F1F5F9;
      color: var(--text);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
    }
    
    .badge.highlight {
      background-color: rgba(16, 185, 129, 0.1);
      color: var(--secondary);
      border-color: rgba(16, 185, 129, 0.2);
    }
    
    .pricing-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 25px;
    }
    
    .pricing-table th, .pricing-table td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    
    .pricing-table th {
      background-color: #F8FAFC;
      font-weight: 600;
      color: var(--dark);
      font-size: 13px;
    }
    
    .pricing-table td {
      font-size: 13px;
      vertical-align: top;
    }
    
    .total-row {
      font-weight: 700;
      font-size: 14px !important;
      color: var(--primary);
      background-color: rgba(79, 70, 229, 0.03);
    }
    
    .footer {
      border-top: 1px solid var(--border);
      padding-top: 15px;
      margin-top: 30px;
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
    }
    
    .note-box {
      background-color: #FFFBEB;
      border: 1px solid #FEF3C7;
      border-left: 4px solid var(--highlight);
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
      color: #92400E;
      margin-bottom: 25px;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="accent-bar"></div>
    <div class="header">
      <div class="logo-area">
        <h1>CRM<span>-Ai4L</span></h1>
      </div>
      <div class="proposal-tag">Project Plan & Budget</div>
    </div>
    
    <div class="intro-msg">
      <span class="intro-label">Message to Client</span>
      "Hey Professor, I’ve worked out a super simple plan for the CRM to keep the development time down and make it easy on your budget. It's going to take a little bit more time than the chat concierge, so I can build you a clean version for $600 AUD. How does that sound?"
    </div>
    
    <h2>
      <span class="section-icon">◆</span> Scope of Work: $600 AUD Clean Version
    </h2>
    <p style="font-size: 13.5px; margin-bottom: 15px; margin-top: 0;">
      To keep development time highly optimized and deliver maximum value within your budget, we will focus on building a robust, high-performance, and clean core implementation of the CRM. Here is the streamlined feature breakdown:
    </p>
    
    <div class="features-grid">
      <div class="feature-card">
        <h3>👥 1. Contact Directory</h3>
        <p>A unified, responsive contact dashboard. Includes search and sorting. Filter contacts instantly by Prospect or Customer status. Form handles all 22 specific client-defined fields.</p>
      </div>
      
      <div class="feature-card">
        <h3>📥 2. Predefined XLS Import</h3>
        <p>Quick spreadsheet importing based on a standardized template. Rather than a complex field-mapping UI, importing expects standard column names, ensuring fast, error-free uploads.</p>
      </div>
      
      <div class="feature-card">
        <h3>⚡ 3. Direct EmailOctopus Integration</h3>
        <p>One-way automated push sync. Creating or updating a contact's newsletter subscription status in the CRM automatically syncs their details to your EmailOctopus list in real time.</p>
      </div>
      
      <div class="feature-card">
        <h3>🛡️ 4. Supabase Secure Backend</h3>
        <p>A secure and fast PostgreSQL database backend. Employs Row-Level Security (RLS) and email authentication to ensure your contact information remains completely private.</p>
      </div>
    </div>
    
    <h2>
      <span class="section-icon">◆</span> Technology Stack
    </h2>
    <div class="tech-badges">
      <span class="badge">Next.js 16 (React)</span>
      <span class="badge">TypeScript</span>
      <span class="badge">Supabase (PostgreSQL & Auth)</span>
      <span class="badge">Vanilla CSS (Aesthetic Custom Theme)</span>
      <span class="badge highlight">EmailOctopus REST API</span>
    </div>
    
    <h2>
      <span class="section-icon">◆</span> Cost & Timeline Breakdown
    </h2>
    <table class="pricing-table">
      <thead>
        <tr>
          <th style="width: 60%;">Deliverable</th>
          <th style="width: 20%;">Timeline</th>
          <th style="width: 20%; text-align: right;">Price (AUD)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <strong>Core Database Schema & Auth Setup</strong><br/>
            <span style="font-size: 11.5px; color: var(--text-muted);">Database migration, contact table structure with 22 fields, and secure admin user login.</span>
          </td>
          <td>Days 1-2</td>
          <td style="text-align: right;">Included</td>
        </tr>
        <tr>
          <td>
            <strong>Interactive CRM Dashboard & Forms</strong><br/>
            <span style="font-size: 11.5px; color: var(--text-muted);">Searchable lists, Prospect/Customer filters, and contact creation/modification forms.</span>
          </td>
          <td>Days 3-4</td>
          <td style="text-align: right;">Included</td>
        </tr>
        <tr>
          <td>
            <strong>Excel Template Import & EmailOctopus Sync</strong><br/>
            <span style="font-size: 11.5px; color: var(--text-muted);">Parsing uploads using SheetJS and integrating the direct API subscription sync.</span>
          </td>
          <td>Days 5-6</td>
          <td style="text-align: right;">Included</td>
        </tr>
        <tr class="total-row">
          <td>Total Project Cost (Fixed Price)</td>
          <td>1 Week</td>
          <td style="text-align: right;">$600.00 AUD</td>
        </tr>
      </tbody>
    </table>
    
    <div class="note-box">
      <strong>💡 Operational Efficiency Note:</strong> By deploying on Vercel's and Supabase's free tiers, the ongoing hosting and database costs will be <strong>$0/month</strong> for initial usage levels, with simple options to scale up later as your list grows.
    </div>
    
    <div class="footer">
      <div>CRM-Ai4L Implementation Proposal</div>
      <div>Date: June 3, 2026</div>
    </div>
  </div>
</body>
</html>`;

async function run() {
  console.log("Launching browser via Playwright...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log("Setting page content...");
  await page.setContent(htmlContent, { waitUntil: 'networkidle' });
  
  // Wait for Google Fonts to load
  await page.waitForTimeout(2500);
  
  const pdfPath = path.join(__dirname, 'CRM_Project_Proposal_600AUD.pdf');
  console.log("Generating PDF at:", pdfPath);
  
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    margin: {
      top: '12mm',
      bottom: '12mm',
      left: '12mm',
      right: '12mm'
    },
    printBackground: true
  });
  
  await browser.close();
  console.log("PDF generation complete!");
}

run().catch(err => {
  console.error("Error generating PDF:", err);
  process.exit(1);
});
