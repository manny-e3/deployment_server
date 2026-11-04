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
    // Test 1: With MYSQL_PWD=''
    const cmd1 = `bash -l -c 'export PATH="/c/xampp/mysql/bin:$PATH"; MYSQL_PWD="" mysql -h 127.0.0.1 -u root -e "SELECT 1;"'`;
    const r1 = await ssh.exec(conn, cmd1);
    console.log('WITH MYSQL_PWD="":', r1);

    // Test 2: Without MYSQL_PWD
    const cmd2 = `bash -l -c 'export PATH="/c/xampp/mysql/bin:$PATH"; mysql -h 127.0.0.1 -u root -e "SELECT 1;"'`;
    const r2 = await ssh.exec(conn, cmd2);
    console.log('WITHOUT MYSQL_PWD:', r2);

    conn.end();
  } catch (err) {
    console.error(err);
  }
})();

