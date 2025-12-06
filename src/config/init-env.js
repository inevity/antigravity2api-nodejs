import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../../.env');

const sensitiveKeys = ['API_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'JWT_SECRET', 'PROXY', 'SYSTEM_INSTRUCTION', 'IMAGE_BASE_URL'];

if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, 'utf8');
  let updated = false;
  
  sensitiveKeys.forEach(key => {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
      updated = true;
    }
  });
  
  if (updated) {
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('✓ 环境变量已同步到 .env');
  }
}
