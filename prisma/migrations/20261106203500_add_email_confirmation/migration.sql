-- AlterTable
ALTER TABLE `User` ADD COLUMN `isEmailVerified` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `EmailConfirmationToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailConfirmationToken_tokenHash_key`(`tokenHash`),
    INDEX `EmailConfirmationToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EmailConfirmationToken` ADD CONSTRAINT `EmailConfirmationToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

