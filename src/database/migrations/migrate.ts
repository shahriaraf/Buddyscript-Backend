import { AppDataSource } from '@db/data-source';
import 'dotenv/config';

async function runMigrations() {
  try {
    console.log('🔌 Connecting to database...');
    console.log('📍 Database:', process.env.DATABASE_URL ? 'Production' : 'Local Docker');
    
    await AppDataSource.initialize();
    console.log('✅ Database connected');
    
    console.log('📝 Running migrations...');
    const migrations = await AppDataSource.runMigrations();
    
    if (migrations.length === 0) {
      console.log('ℹ️  No pending migrations');
    } else {
      console.log(`✅ Successfully ran ${migrations.length} migration(s):`);
      migrations.forEach(migration => {
        console.log(`   - ${migration.name}`);
      });
    }
    
    await AppDataSource.destroy();
    console.log('🎉 Migration completed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:');
    console.error(error);
    process.exit(1);
  }
}

runMigrations();