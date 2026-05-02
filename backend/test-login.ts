
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function diagnose() {
  console.log('🔍 Starting Password Diagnosis...\n');
  
  const user = await prisma.user.findUnique({ where: { email: 'admin@vfsbot.local' } });
  
  if (!user) {
    console.log('❌ ERROR: Admin user NOT FOUND in database.');
    return;
  }
  
  console.log('✅ Admin user found.');
  console.log('📊 Stored Hash:', user.passwordHash);
  
  const testPassword = 'admin1234';
  const isValid = await bcrypt.compare(testPassword, user.passwordHash);
  
  if (isValid) {
    console.log('✅ SUCCESS: Plaintext "admin1234" MATCHES the stored hash.');
  } else {
    console.log('❌ FAILURE: Plaintext "admin1234" DOES NOT match the stored hash.');
    
    // Attempt a re-hash and update to fix it
    console.log('\n🔧 Attempting to FIX the hash...');
    const newHash = await bcrypt.hash(testPassword, 12);
    await prisma.user.update({
      where: { email: 'admin@vfsbot.local' },
      data: { passwordHash: newHash }
    });
    console.log('✅ Hash UPDATED. Please try logging in again.');
  }
}

diagnose()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
