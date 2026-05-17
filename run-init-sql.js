// Script pour exécuter init.sql sur PostgreSQL Railway
// Exécutez avec: node run-init-sql.js

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Configuration PostgreSQL Railway
const pool = new Pool({
  host: 'caboose.proxy.rlwy.net',
  port: 52628,
  user: 'postgres',
  password: 'YvqScetDzAvLaiJuJojvUdoFGjpIqPfD',
  database: 'railway',
});

async function runInitSQL() {
  const client = await pool.connect();
  
  try {
    // Lire le fichier init.sql
    const initSQLPath = 'C:/Users/ntoua/Downloads/wrestling-tournament-backend/init.sql';
    const sql = fs.readFileSync(initSQLPath, 'utf8');
    
    console.log('📝 Exécution de init.sql...');
    
    // Exécuter le script SQL
    await client.query(sql);
    
    console.log('✅ init.sql exécuté avec succès !');
    
    // Vérifier les tables créées
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"
    );
    
    console.log('\n📊 Tables créées :');
    result.rows.forEach(row => {
      console.log(`  ✅ ${row.table_name}`);
    });
    
  } catch (error) {
    console.error('❌ Erreur lors de l\'exécution de init.sql:');
    console.error(error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

runInitSQL();
