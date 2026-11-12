const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function update() {
  const target = await p.target.findUnique({ where: { id: 'cmw9s1lah0006gz1gm4ax2y8l' } });
  let postDeploy = target.postDeploy;

  const insertion = `ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

# Ensure LiteSpeed reverse proxy .htaccess exists
cat << 'HTACCESS' > "$APP_DIR/.htaccess"
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^(.*)$ http://127.0.0.1:9000/$1 [P,L]
</IfModule>
HTACCESS

# Symlink release node_modules into APP_DIR root so ecosystem.config.js finds dependencies
ln -sfn "$RELEASE_DIR/node_modules" "$APP_DIR/node_modules"`;

  if (!postDeploy.includes('RewriteRule ^(.*)$ http://127.0.0.1:9000/$1')) {
    postDeploy = postDeploy.replace('ln -sfn "$RELEASE_DIR" "$APP_DIR/current"', insertion);
    await p.target.update({
      where: { id: 'cmw9s1lah0006gz1gm4ax2y8l' },
      data: { postDeploy },
    });
    console.log('Successfully updated postDeploy for target cmw9s1lah0006gz1gm4ax2y8l');
  } else {
    console.log('postDeploy already updated');
  }
}

update().finally(() => p.$disconnect());

