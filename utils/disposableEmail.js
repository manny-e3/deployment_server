/**
 * Backend utility for detecting disposable / temporary email domains.
 */
const DISPOSABLE_DOMAINS_SET = new Set([
  // Mailinator & family
  'mailinator.com',
  'mailinator.net',
  'mailinator.org',
  'mailinator2.com',
  'mailin8r.com',
  'suremail.info',
  'reconmail.com',
  'safetymail.info',

  // Guerrilla Mail
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.biz',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'pokemail.net',
  'spam4.me',

  // 10 Minute Mail & variants
  '10minutemail.com',
  '10minutemail.net',
  '10minutemail.org',
  '10minute-mail.com',
  '10minemail.com',
  '10mail.org',
  'minuteinbox.com',

  // Temp Mail & Temp-Mail
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempmail.net',
  'tempmail.plus',
  'temp-mail.ru',
  'tempail.com',
  'tempr.email',
  'disposablemail.com',

  // YOPmail & aliases
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'cool.fr.nf',
  'jetable.fr.nf',
  'courriel.fr.nf',
  'moncourrier.fr.nf',
  'monemail.fr.nf',
  'monmail.fr.nf',
  'mega.zik.dj',
  'speed.1s.fr',

  // TrashMail
  'trashmail.com',
  'trashmail.net',
  'trashmail.me',
  'trashmail.org',
  'trashymail.com',

  // Dispostable, Maildrop, Nada, Burner
  'dispostable.com',
  'maildrop.cc',
  'burnermail.io',
  'getnada.com',
  'nada.ltd',
  'nada.email',
  'inboxkitten.com',
  'getairmail.com',
  'mohmal.com',
  'mohmal.in',
  'crazymailing.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'mytemp.email',
  'emailondeck.com',
  'generator.email',
  'fakemailgenerator.com',
  'mailcatch.com',
  'mailnesia.com',
  'tmailor.com',
  'mailsac.com',
  'harakirimail.com',
  'mytempemail.com',
  'meltmail.com',
  'spamgourmet.com',
  'spamfree24.org',
  'boun.cr',
  'dropmail.me',
  'inboxbear.com',
  'zillamail.com',
  'anonymousemail.me',
  'mintemail.com',
  'discard.email',
  'discardmail.com',
  'spambog.com',
  'deadaddress.com',
  'fakemail.net',
  'tempinbox.com',
  'incognitmail.org',
  'boximail.com',
  'crazymail.com',
  'trash-mail.at',
  'trash-mail.ch',
  'trash-mail.com',

  // Fake / temporary testing domains
  'armyspy.com',
  'cuvox.de',
  'dayrep.com',
  'fleckens.hu',
  'gustr.com',
  'jourrapide.com',
  'rhyta.com',
  'superrito.com',
  'teleworm.us',
  'einrot.com',
  'chacuo.net',
]);

function isDisposableDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const d = domain.trim().toLowerCase();
  if (DISPOSABLE_DOMAINS_SET.has(d)) return true;

  const parts = d.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.');
    if (DISPOSABLE_DOMAINS_SET.has(parent)) return true;
  }
  return false;
}

function checkDisposableEmail(email) {
  if (!email || typeof email !== 'string') {
    return { isDisposable: false, domain: '', message: null };
  }

  const clean = email.trim().toLowerCase();
  const atIndex = clean.lastIndexOf('@');
  if (atIndex === -1 || atIndex === clean.length - 1) {
    return { isDisposable: false, domain: '', message: null };
  }

  const domain = clean.slice(atIndex + 1);
  if (isDisposableDomain(domain)) {
    return {
      isDisposable: true,
      domain,
      message: `${domain} is a disposable domain. Please use a non-disposable email.`,
    };
  }

  return { isDisposable: false, domain, message: null };
}

module.exports = { isDisposableDomain, checkDisposableEmail };

