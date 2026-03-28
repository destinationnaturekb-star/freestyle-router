const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Routing map: doc_type → array of { envKey, label }
const ROUTING = {
  BOL:                    [{ envKey: 'EMAIL_DIDO', label: 'Imaging' }, { envKey: 'EMAIL_DISPATCHER', label: 'Dispatcher' }],
  LUMPER_RECEIPT:         [{ envKey: 'EMAIL_ACCOUNTING', label: 'Accounting' }, { envKey: 'EMAIL_DISPATCHER', label: 'Dispatcher' }],
  SCALE_TICKET:           [{ envKey: 'EMAIL_DISPATCHER', label: 'Dispatcher' }, { envKey: 'EMAIL_SAFETY', label: 'Safety' }],
  REIMBURSEMENT_RECEIPT:  [{ envKey: 'EMAIL_ACCOUNTING', label: 'Accounting' }],
  RATE_CONFIRMATION:      [{ envKey: 'EMAIL_DISPATCHER', label: 'Dispatcher' }],
  FUEL_RECEIPT:           [{ envKey: 'EMAIL_ACCOUNTING', label: 'Accounting' }],
  INSPECTION_REPORT:      [{ envKey: 'EMAIL_SAFETY', label: 'Safety' }, { envKey: 'EMAIL_MAINTENANCE', label: 'Maintenance' }],
  OTHER:                  [{ envKey: 'EMAIL_DISPATCHER', label: 'Dispatcher' }, { envKey: 'EMAIL_OWNER', label: 'Owner' }],
};

// Friendly names for doc types
const DOC_NAMES = {
  BOL: 'Bill of Lading',
  LUMPER_RECEIPT: 'Lumper Receipt',
  SCALE_TICKET: 'Scale Ticket',
  REIMBURSEMENT_RECEIPT: 'Reimbursement Receipt',
  RATE_CONFIRMATION: 'Rate Confirmation',
  FUEL_RECEIPT: 'Fuel Receipt',
  INSPECTION_REPORT: 'Inspection Report',
  OTHER: 'Other Document',
};

// Classify document using Anthropic API
async function classifyDocument(imageBase64, mediaType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: `You are a document classifier for a trucking company.
Look at this document image and identify what type it is.

Respond ONLY with a JSON object, no markdown:
{
  "doc_type": one of: BOL, LUMPER_RECEIPT, SCALE_TICKET, REIMBURSEMENT_RECEIPT, RATE_CONFIRMATION, FUEL_RECEIPT, INSPECTION_REPORT, OTHER,
  "confidence": "high" or "low",
  "note": "one short plain English phrase describing what you see",
  "page_info": "e.g. page 1 of 3, or single page, or unknown",
  "quality": "good" or "blurry" or "too_dark"
}

Doc type definitions:
- BOL: Bill of Lading — delivery document with shipper, consignee, weight, signatures
- LUMPER_RECEIPT: Receipt for unloading labor at delivery
- SCALE_TICKET: Weight station ticket showing gross weight
- REIMBURSEMENT_RECEIPT: Any receipt driver paid out of pocket — fuel, supplies, parking, etc.
- RATE_CONFIRMATION: Broker load confirmation with rate, pickup and delivery addresses
- FUEL_RECEIPT: EFS, Comdata, or regular fuel station receipt
- INSPECTION_REPORT: DOT, safety, or annual inspection docs
- OTHER: Anything else`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();
  return JSON.parse(text);
}

// Send email with attachment
async function sendEmail(to, subject, body, imageBase64, mediaType) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const ext = mediaType.split('/')[1] || 'png';

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    text: body,
    attachments: [
      {
        filename: `document.${ext}`,
        content: imageBase64,
        encoding: 'base64',
        contentType: mediaType,
      },
    ],
  });
}

// Main route endpoint
app.post('/api/route', async (req, res) => {
  try {
    const { imageBase64, mediaType, dispatcherName, docType } = req.body;

    if (!imageBase64 || !mediaType) {
      return res.status(400).json({ error: 'Missing imageBase64 or mediaType' });
    }

    // Step 1: Classify via AI for quality/page info, but use driver-selected type for routing
    let note = '', page_info = 'unknown', quality = 'good';
    try {
      const classification = await classifyDocument(imageBase64, mediaType);
      note = classification.note || '';
      page_info = classification.page_info || 'unknown';
      quality = classification.quality || 'good';
    } catch (aiErr) {
      console.warn('AI classification failed, proceeding with driver-selected type:', aiErr.message);
    }

    // Use driver-selected doc type if provided, otherwise fall back to AI
    const doc_type = docType || 'OTHER';

    // Step 2: Determine recipients
    const routes = ROUTING[doc_type] || ROUTING.OTHER;
    const recipients = routes.map(r => ({
      email: process.env[r.envKey],
      label: r.label,
    })).filter(r => r.email);

    // Step 3: Send emails
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const poorQuality = quality === 'blurry' || quality === 'too_dark';
    const subjectPrefix = poorQuality ? `⚠️ ${doc_type} — POOR QUALITY` : doc_type;
    const subject = `${subjectPrefix} from Driver — ${timestamp}`;

    const body = [
      `Document type: ${DOC_NAMES[doc_type] || doc_type}`,
      `Detected: ${note}`,
      `Page info: ${page_info}`,
      `Quality: ${quality}`,
      `Dispatcher: ${dispatcherName || 'Not specified'}`,
      `Uploaded: ${timestamp}`,
    ].join('\n');

    await Promise.all(
      recipients.map(r => sendEmail(r.email, subject, body, imageBase64, mediaType))
    );

    // Step 4: Return result
    res.json({
      doc_type,
      doc_name: DOC_NAMES[doc_type] || doc_type,
      note,
      routed_to: recipients.map(r => r.label),
      quality,
      page_info,
      warning: poorQuality ? 'Poor image quality — please retake' : null,
    });
  } catch (err) {
    console.error('Route error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Freestyle Router running on port ${PORT}`);
});
