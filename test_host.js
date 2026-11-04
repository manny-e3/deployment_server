const ssh = require('./utils/ssh');

(async () => {
  try {
    const { conn } = await ssh.connect({
      host: '10.10.15.59',
      port: 22,
      username: 'aboajah.emmanuel@fmdqgroup.com',
      authType: 'PASSWORD',
      secret: 'BadBoy@28',
    });

    const pathPrefix = 'export PATH="/c/xampp/mysql/bin:$PATH"';

    // Test 1: -h localhost with MYSQL_PWD=""
    const r1 = await ssh.exec(conn, `bash -l -c '${pathPrefix}; MYSQL_PWD="" mysql -h localhost -u root -e "SELECT 1;"'`);
    console.log('Test 1 (localhost + MYSQL_PWD=""):', r1);

    // Test 2: -h localhost WITHOUT MYSQL_PWD
    const r2 = await ssh.exec(conn, `bash -l -c '${pathPrefix}; mysql -h localhost -u root -e "SELECT 1;"'`);
    console.log('Test 2 (localhost WITHOUT MYSQL_PWD):', r2);

    // Test 3: -h 127.0.0.1 with MYSQL_PWD=""
    const r3 = await ssh.exec(conn, `bash -l -c '${pathPrefix}; MYSQL_PWD="" mysql -h 127.0.0.1 -u root -e "SELECT 1;"'`);
    console.log('Test 3 (127.0.0.1 + MYSQL_PWD=""):', r3);

    // Test 4: -h 127.0.0.1 WITHOUT MYSQL_PWD
    const r4 = await ssh.exec(conn, `bash -l -c '${pathPrefix}; mysql -h 127.0.0.1 -u root -e "SELECT 1;"'`);
    console.log('Test 4 (127.0.0.1 WITHOUT MYSQL_PWD):', r4);

    conn.end();
  } catch (err) {
    console.error(err);
  }
})();

