const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const upload = multer({ storage: multer.memoryStorage() });

const JWT_SECRET = "ZOLIMAR_SECRET_2026";
const dbPath = path.join(__dirname, 'public', 'zolimar.db');
const db = new sqlite3.Database(dbPath);

app.use(cors());
app.use(express.json());

// Servir la carpeta public como estática
app.use(express.static(path.join(__dirname, 'public')));

// Ruta Principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicializar Tablas en la Base de Datos y asegurar usuarios e invitados por defecto
db.serialize(async () => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password_hash TEXT, role TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY, service_status TEXT, food_service INTEGER, drink_service INTEGER, food_type TEXT, drink_type TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, table_id INTEGER, seat TEXT, dietary TEXT, tag TEXT, status TEXT, food_served INTEGER DEFAULT 0, drink_served INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, action TEXT, details TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // Migraciones seguras para agregar columnas food_type, drink_type, food_served, drink_served
  db.run(`ALTER TABLE tables ADD COLUMN food_type TEXT`, () => {});
  db.run(`ALTER TABLE tables ADD COLUMN drink_type TEXT`, () => {});
  db.run(`ALTER TABLE guests ADD COLUMN food_served INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE guests ADD COLUMN drink_served INTEGER DEFAULT 0`, () => {});

  // Crear 20 mesas si no existen
  for (let i = 1; i <= 20; i++) {
    db.run(`INSERT OR IGNORE INTO tables (id, service_status, food_service, drink_service, food_type, drink_type) VALUES (?, 'Pending', 1, 0, 'Menú Estándar', 'Agua & Gaseosa')`, [i]);
  }

  // Garantizar usuario ADMIN por defecto con contraseña funcional 'admin123'
  const adminEmail = 'admin@zolimar.com';
  const hashedAdmin = await bcrypt.hash('admin123', 10);
  db.get(`SELECT * FROM users WHERE email = ?`, [adminEmail], (err, user) => {
    if (!user) {
      db.run(`INSERT INTO users (name, email, password_hash, role) VALUES ('Super Admin', ?, ?, 'ADMIN')`, [adminEmail, hashedAdmin]);
    } else if (!bcrypt.compareSync('admin123', user.password_hash)) {
      db.run(`UPDATE users SET password_hash = ? WHERE email = ?`, [hashedAdmin, adminEmail]);
    }
  });

  // Garantizar usuario MESERO por defecto con contraseña funcional 'mesero123'
  const waiterEmail = 'mesero@zolimar.com';
  const hashedWaiter = await bcrypt.hash('mesero123', 10);
  db.get(`SELECT * FROM users WHERE email = ?`, [waiterEmail], (err, user) => {
    if (!user) {
      db.run(`INSERT INTO users (name, email, password_hash, role) VALUES ('Mesero 1', ?, ?, 'WAITER')`, [waiterEmail, hashedWaiter]);
    } else if (!bcrypt.compareSync('mesero123', user.password_hash)) {
      db.run(`UPDATE users SET password_hash = ? WHERE email = ?`, [hashedWaiter, waiterEmail]);
    }
  });

  // Poblar lista inicial de invitados reales si la tabla está vacía
  db.get(`SELECT count(*) as count FROM guests`, (err, row) => {
    if (!err && row && row.count === 0) {
      const sampleGuests = [
        { name: "Ana Gómez", table_id: 1, seat: "1", dietary: "Standard", tag: "Standard", status: "Pending", food_served: 0, drink_served: 0 },
        { name: "Ana María Silva", table_id: 1, seat: "2", dietary: "Vegetariano", tag: "Vegetarian", status: "In Progress", food_served: 1, drink_served: 0 },
        { name: "Carlos Mendoza", table_id: 1, seat: "3", dietary: "Sin Gluten", tag: "Sin Gluten", status: "Served", food_served: 1, drink_served: 1 },
        { name: "María García", table_id: 2, seat: "1", dietary: "Standard", tag: "Standard", status: "Pending", food_served: 0, drink_served: 0 },
        { name: "José Rodríguez", table_id: 2, seat: "2", dietary: "Vegano", tag: "Vegano", status: "In Progress", food_served: 0, drink_served: 1 },
        { name: "Sofía López", table_id: 3, seat: "1", dietary: "Standard", tag: "Standard", status: "Pending", food_served: 0, drink_served: 0 },
        { name: "Fernando Torres", table_id: 3, seat: "2", dietary: "Standard", tag: "Standard", status: "Pending", food_served: 0, drink_served: 0 },
        { name: "Lucía Fernández", table_id: 4, seat: "1", dietary: "Vegetariano", tag: "Vegetarian", status: "Served", food_served: 1, drink_served: 1 },
        { name: "Diego Morales", table_id: 5, seat: "1", dietary: "Standard", tag: "Standard", status: "Pending", food_served: 0, drink_served: 0 },
        { name: "Elena Benítez", table_id: 5, seat: "2", dietary: "Standard", tag: "Standard", status: "In Progress", food_served: 1, drink_served: 0 }
      ];
      const stmt = db.prepare(`INSERT INTO guests (name, table_id, seat, dietary, tag, status, food_served, drink_served) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      sampleGuests.forEach(g => stmt.run([g.name, g.table_id, g.seat, g.dietary, g.tag, g.status, g.food_served, g.drink_served]));
      stmt.finalize();
    }
  });
});

// Middleware de Autenticación JWT
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado. Inicie sesión nuevamente.' });
  
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido o expirado. Inicie sesión nuevamente.' });
  }
}

// Helper flexible para extraer valores de filas Excel según múltiples nombres de columna
function getRowValue(row, patterns) {
  const keys = Object.keys(row);
  for (const pattern of patterns) {
    const matchedKey = keys.find(k => k.trim().toLowerCase().replace(/[^a-z0-9áéíóúñ]/gi, '').includes(pattern.toLowerCase()));
    if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== null && String(row[matchedKey]).trim() !== '') {
      return String(row[matchedKey]).trim();
    }
  }
  return null;
}

// 1. Iniciar Sesión
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Por favor ingrese correo y contraseña' });
  }

  const cleanEmail = email.trim().toLowerCase();
  db.get(`SELECT * FROM users WHERE LOWER(email) = ?`, [cleanEmail], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Error en la base de datos' });
    }
    if (!user) {
      return res.status(400).json({ error: 'Correo o contraseña incorrectos' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Correo o contraseña incorrectos' });
    }

    const token = jwt.sign({ id: user.id, name: user.name, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

// 2. Verificar Sesión Actual
app.get('/api/auth/me', auth, (req, res) => {
  db.get(`SELECT id, name, email, role FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ user });
  });
});

// 3. Cambiar Contraseña de Usuario Logueado
app.post('/api/auth/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Debe ingresar la contraseña actual y la nueva contraseña' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  }

  db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id], (updateErr) => {
      if (updateErr) return res.status(500).json({ error: 'Error actualizando contraseña' });
      res.json({ message: 'Contraseña actualizada exitosamente' });
    });
  });
});

// 4. Obtener todos los datos (Mesas e Invitados)
app.get('/api/event-data', auth, (req, res) => {
  db.all(`SELECT * FROM tables ORDER BY id ASC`, [], (err, tables) => {
    if (err) return res.status(500).json({ error: 'Error al consultar mesas' });
    db.all(`SELECT * FROM guests ORDER BY table_id ASC, id ASC`, [], (err2, guests) => {
      if (err2) return res.status(500).json({ error: 'Error al consultar invitados' });
      res.json({ tables, guests });
    });
  });
});

// 5. Agregar un Invitado Manualmente
app.post('/api/guests/create', auth, (req, res) => {
  const { name, table_id, seat, dietary, tag } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre del invitado es obligatorio' });
  }

  const cleanName = name.trim();
  const tableId = parseInt(table_id || 1);
  const seatNum = String(seat || 1);
  const diet = dietary || 'Standard';
  const tagStr = tag || (diet.toLowerCase().includes('vege') ? 'Vegetarian' : 'Standard');

  db.run(
    `INSERT INTO guests (name, table_id, seat, dietary, tag, status, food_served, drink_served) VALUES (?, ?, ?, ?, ?, 'Pending', 0, 0)`,
    [cleanName, tableId, seatNum, diet, tagStr],
    function(err) {
      if (err) return res.status(500).json({ error: 'Error al agregar invitado: ' + err.message });
      io.emit('refresh-data');
      res.json({ message: `Invitado '${cleanName}' agregado con éxito.`, guestId: this.lastID });
    }
  );
});

// 6. Eliminar un Invitado
app.post('/api/guests/delete', auth, (req, res) => {
  const { guestId } = req.body;
  if (!guestId) return res.status(400).json({ error: 'ID de invitado requerido' });

  db.run(`DELETE FROM guests WHERE id = ?`, [guestId], function(err) {
    if (err) return res.status(500).json({ error: 'Error al eliminar invitado' });
    io.emit('refresh-data');
    res.json({ message: 'Invitado eliminado con éxito.' });
  });
});

// 7. Subir Excel / CSV COMPLETO
app.post('/api/guests/upload', auth, upload.single('file'), (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden cargar listas' });
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'El archivo Excel no contiene hojas válidas' });

    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { defval: "", raw: false });

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel está vacío o no tiene formato de tabla válido' });
    }

    db.serialize(() => {
      db.all(`SELECT * FROM guests`, (err, prevGuests) => {
        db.run(`INSERT INTO audit_logs (user_name, action, details) VALUES (?, 'IMPORT_GUESTS', ?)`, 
          [req.user.name, JSON.stringify(prevGuests || [])]);
      });

      db.run('BEGIN TRANSACTION', () => {
        db.run(`DELETE FROM guests`, () => {
          const stmt = db.prepare(`INSERT INTO guests (name, table_id, seat, dietary, tag, status, food_served, drink_served) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

          let importedCount = 0;

          data.forEach((row, idx) => {
            const rawName = getRowValue(row, ['invitado', 'nombre', 'guest', 'persona', 'nombres', 'cliente', 'asistente', 'name']);
            if (!rawName && Object.values(row).every(val => String(val).trim() === '')) return;

            const guestName = rawName || `Invitado ${idx + 1}`;

            const rawTable = getRowValue(row, ['mesa', 'table', 'nromesa', 'nummesa']);
            let tableNum = (idx % 20) + 1;
            if (rawTable) {
              const matchDigits = rawTable.match(/\d+/);
              if (matchDigits) tableNum = parseInt(matchDigits[0]);
            }

            const rawSeat = getRowValue(row, ['silla', 'asiento', 'seat', 'nrosilla']);
            let seatNum = String((idx % 10) + 1);
            if (rawSeat) {
              const matchSeatDigits = rawSeat.match(/\d+/);
              if (matchSeatDigits) seatNum = String(matchSeatDigits[0]);
              else seatNum = rawSeat;
            }

            const rawStatus = getRowValue(row, ['estado', 'status', 'asistencia', 'llegó', 'llego', 'servido']);
            let status = 'Pending';
            let foodServed = 0;
            let drinkServed = 0;

            if (rawStatus) {
              const lowerSt = rawStatus.toLowerCase();
              if (lowerSt.includes('lleg') || lowerSt.includes('check') || lowerSt.includes('presente') || lowerSt.includes('asistio') || lowerSt.includes('confirm')) {
                status = 'In Progress';
              } else if (lowerSt.includes('serv') || lowerSt.includes('atend') || lowerSt.includes('comio') || lowerSt.includes('completo')) {
                status = 'Served';
                foodServed = 1;
                drinkServed = 1;
              } else if (lowerSt.includes('pend') || lowerSt.includes('falt') || lowerSt.includes('no')) {
                status = 'Pending';
              } else {
                status = rawStatus;
              }
            }

            const rawDietary = getRowValue(row, ['dieta', 'dietary', 'menu', 'menú', 'restriccion', 'preferencia']);
            const dietary = rawDietary || 'Standard';
            const tag = (dietary.toLowerCase().includes('vege') ? 'Vegetarian' : (dietary.toLowerCase().includes('vega') ? 'Vegano' : 'Standard'));

            stmt.run([guestName, tableNum, seatNum, dietary, tag, status, foodServed, drinkServed]);
            importedCount++;
          });

          stmt.finalize((finalizeErr) => {
            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                return res.status(500).json({ error: 'Error al confirmar la carga en la base de datos' });
              }
              io.emit('refresh-data');
              res.json({ message: `¡Éxito! Se importaron los ${importedCount} invitados de la lista completa.` });
            });
          });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al procesar el archivo Excel: ' + err.message });
  }
});

// 8. Revertir último error/carga (Solo Admin)
app.post('/api/admin/undo-last', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo Admin puede revertir' });

  db.get(`SELECT * FROM audit_logs WHERE action = 'IMPORT_GUESTS' ORDER BY id DESC LIMIT 1`, [], (err, log) => {
    if (err || !log) return res.status(400).json({ error: 'No hay cargas anteriores registradas para revertir' });

    try {
      const previousGuests = JSON.parse(log.details);
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', () => {
          db.run(`DELETE FROM guests`, () => {
            if (previousGuests.length > 0) {
              const stmt = db.prepare(`INSERT INTO guests (id, name, table_id, seat, dietary, tag, status, food_served, drink_served) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
              previousGuests.forEach(g => stmt.run([g.id, g.name, g.table_id, g.seat, g.dietary, g.tag, g.status, g.food_served || 0, g.drink_served || 0]));
              stmt.finalize((stmtErr) => {
                db.run('COMMIT', () => {
                  io.emit('refresh-data');
                  res.json({ message: 'Se restauraron todos los datos al estado anterior.' });
                });
              });
            } else {
              db.run('COMMIT', () => {
                io.emit('refresh-data');
                res.json({ message: 'Se restauraron los datos al estado anterior.' });
              });
            }
          });
        });
      });
    } catch (parseErr) {
      res.status(500).json({ error: 'Error restaurando respaldo previo' });
    }
  });
});

// 9. Actualizar Estado Individual de Invitado / Usuario (Comida, Agua, Estado)
app.post('/api/guests/status', auth, (req, res) => {
  const { guestId, status, food_served, drink_served, dietary, tag } = req.body;
  if (!guestId) return res.status(400).json({ error: 'ID de invitado requerido' });

  db.get(`SELECT * FROM guests WHERE id = ?`, [guestId], (err, currentGuest) => {
    if (err || !currentGuest) return res.status(404).json({ error: 'Invitado no encontrado' });

    const newFoodServed = food_served !== undefined ? (food_served ? 1 : 0) : currentGuest.food_served;
    const newDrinkServed = drink_served !== undefined ? (drink_served ? 1 : 0) : currentGuest.drink_served;
    const newDietary = dietary !== undefined ? dietary : currentGuest.dietary;
    const newTag = tag !== undefined ? tag : currentGuest.tag;

    // Si tiene su comida y su agua servidas, el estado pasa automáticamente a 'Served' (Plomo)
    let newStatus = status !== undefined ? status : currentGuest.status;
    if (newFoodServed === 1 && newDrinkServed === 1) {
      newStatus = 'Served';
    }

    db.run(
      `UPDATE guests SET status = ?, food_served = ?, drink_served = ?, dietary = ?, tag = ? WHERE id = ?`,
      [newStatus, newFoodServed, newDrinkServed, newDietary, newTag, guestId],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: 'Error actualizando estado del invitado' });
        io.emit('refresh-data');
        res.json({ success: true, guest: { id: guestId, status: newStatus, food_served: newFoodServed, drink_served: newDrinkServed } });
      }
    );
  });
});

// 10. Cambiar Estado y Detalles del Servicio de Mesa (Comida y Bebida)
app.post('/api/tables/status', auth, (req, res) => {
  const { tableId, serviceStatus, foodService, drinkService, foodType, drinkType } = req.body;
  if (!tableId) return res.status(400).json({ error: 'Parámetro tableId requerido' });

  db.get(`SELECT * FROM tables WHERE id = ?`, [tableId], (err, currentTable) => {
    if (err || !currentTable) return res.status(404).json({ error: 'Mesa no encontrada' });

    const newServiceStatus = serviceStatus !== undefined ? serviceStatus : currentTable.service_status;
    const newFoodService = foodService !== undefined ? (foodService ? 1 : 0) : currentTable.food_service;
    const newDrinkService = drinkService !== undefined ? (drinkService ? 1 : 0) : currentTable.drink_service;
    const newFoodType = foodType !== undefined ? foodType : (currentTable.food_type || 'Menú Estándar');
    const newDrinkType = drinkType !== undefined ? drinkType : (currentTable.drink_type || 'Agua & Gaseosa');

    db.run(
      `UPDATE tables SET service_status = ?, food_service = ?, drink_service = ?, food_type = ?, drink_type = ? WHERE id = ?`,
      [newServiceStatus, newFoodService, newDrinkService, newFoodType, newDrinkType, tableId],
      (updateErr) => {
        if (updateErr) return res.status(500).json({ error: 'Error actualizando mesa: ' + updateErr.message });
        
        // Si el estado de la mesa cambia a Served o In Progress, actualizar opcionalmente a todos los invitados de la mesa
        if (serviceStatus === 'Served') {
          db.run(`UPDATE guests SET status = 'Served', food_served = 1, drink_served = 1 WHERE table_id = ?`, [tableId], () => {
            io.emit('refresh-data');
            res.json({ success: true });
          });
        } else if (serviceStatus === 'Pending') {
          db.run(`UPDATE guests SET status = 'Pending', food_served = 0, drink_served = 0 WHERE table_id = ?`, [tableId], () => {
            io.emit('refresh-data');
            res.json({ success: true });
          });
        } else {
          io.emit('refresh-data');
          res.json({ success: true });
        }
      }
    );
  });
});

// Iniciar Servidor en el Puerto 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  Zolimar Catering Server ACTIVO`);
  console.log(`  Entra en tu navegador a: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
