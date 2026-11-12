const { Router } = require('express');
const { sendContactFormEmail } = require('../services/email.service');
const { logger } = require('../utils/logger');

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { name, email, category, subject, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({
        ok: false,
        error: { message: 'Name, email, and message are required fields.' },
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(email).trim())) {
      return res.status(400).json({
        ok: false,
        error: { message: 'Please provide a valid email address.' },
      });
    }

    await sendContactFormEmail({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      category: category ? String(category).trim() : 'General',
      subject: subject ? String(subject).trim() : 'PortalOps Support Inquiry',
      message: String(message).trim(),
    });

    return res.status(200).json({
      ok: true,
      message: 'Your inquiry has been successfully delivered to info@portalops.online. Our engineering team will follow up shortly.',
    });
  } catch (err) {
    logger.error({ err }, 'Failed to deliver contact inquiry to info@portalops.online');
    return res.status(500).json({
      ok: false,
      error: {
        message: 'Unable to send message via mail gateway. Please email info@portalops.online directly.',
      },
    });
  }
});

module.exports = router;

