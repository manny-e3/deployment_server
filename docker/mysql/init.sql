-- Runs once, when the MySQL volume is first created.
CREATE DATABASE IF NOT EXISTS portal_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS portal_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON portal_test.* TO 'portal'@'%';
GRANT ALL PRIVILEGES ON portal_shadow.* TO 'portal'@'%';
FLUSH PRIVILEGES;
