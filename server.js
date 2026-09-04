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

// Configuración de almacenamiento en disco para imágenes del evento
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `event_banner_${Date.now()}${ext}`);
  }
});
const uploadBanner = multer({ storage: bannerStorage });

const JWT_SECRET = "ZOLIMAR_SECRET_2026";
const dbPath = path.join(__dirname, 'public', 'zolimar.db');
const db = new sqlite3.Database(dbPath);

app.use(cors());
app.use(express.json());

// Desactivar caché estática para que siempre se reciba la versión más reciente en vivo
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Servir la carpeta public como estática
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
}));

// Ruta Principal
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicializar Tablas en la Base de Datos y asegurar usuarios e invitados por defecto
db.serialize(async () => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password_hash TEXT, role TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY, service_status TEXT, food_service INTEGER, drink_service INTEGER, food_type TEXT, drink_type TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, table_id INTEGER, seat TEXT, dietary TEXT, tag TEXT, status TEXT, food_served INTEGER DEFAULT 0, drink_served INTEGER DEFAULT 0, notes TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, action TEXT, details TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS event_info (id INTEGER PRIMARY KEY, event_name TEXT, banner_url TEXT)`);

  // Migraciones seguras para agregar columnas food_type, drink_type, food_served, drink_served, notes
  db.run(`ALTER TABLE tables ADD COLUMN food_type TEXT`, () => {});
  db.run(`ALTER TABLE tables ADD COLUMN drink_type TEXT`, () => {});
  db.run(`ALTER TABLE guests ADD COLUMN food_served INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE guests ADD COLUMN drink_served INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE guests ADD COLUMN notes TEXT`, () => {});

  // Asegurar registro inicial en event_info
  db.get(`SELECT count(*) as count FROM event_info`, (err, row) => {
    if (!err && row && row.count === 0) {
      db.run(`INSERT INTO event_info (id, event_name, banner_url) VALUES (1, 'Zolimar Catering & Eventos', '/bg-event-1.jpg')`);
    }
  });

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

  // Tabla de Catálogo del Menú del Día (Comidas y Bebidas)
  db.run(`CREATE TABLE IF NOT EXISTS menu_catalog (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, name TEXT, is_active INTEGER DEFAULT 1)`);

  // Poblar catálogo inicial si está vacío
  db.get(`SELECT count(*) as count FROM menu_catalog`, (err, row) => {
    if (!err && row && row.count === 0) {
      const defaultMenu = [
        { category: 'food', name: 'Menú Estándar' },
        { category: 'food', name: 'Lomo Saltado Gourmet' },
        { category: 'food', name: 'Vegetariano' },
        { category: 'food', name: 'Vegano' },
        { category: 'food', name: 'Sin Gluten' },
        { category: 'food', name: 'Menú Infantil' },
        { category: 'drink', name: 'Agua & Gaseosa' },
        { category: 'drink', name: 'Vino Tinto / Blanco' },
        { category: 'drink', name: 'Cerveza Artesanal' },
        { category: 'drink', name: 'Coctelería Zolimar' },
        { category: 'drink', name: 'Whisky & Bar Libre' }
      ];
      const stmt = db.prepare(`INSERT INTO menu_catalog (category, name, is_active) VALUES (?, ?, 1)`);
      defaultMenu.forEach(item => stmt.run([item.category, item.name]));
      stmt.finalize();
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

// 4. Obtener todos los datos (Mesas, Invitados, Catálogo y Configuración del Evento)
app.get('/api/event-data', auth, (req, res) => {
  db.all(`SELECT * FROM tables ORDER BY id ASC`, [], (err, tables) => {
    if (err) return res.status(500).json({ error: 'Error al consultar mesas' });
    db.all(`SELECT * FROM guests ORDER BY table_id ASC, id ASC`, [], (err2, guests) => {
      if (err2) return res.status(500).json({ error: 'Error al consultar invitados' });
      db.all(`SELECT * FROM menu_catalog WHERE is_active = 1 ORDER BY id ASC`, [], (err3, menuCatalog) => {
        if (err3) menuCatalog = [];
        db.get(`SELECT * FROM event_info WHERE id = 1`, [], (err4, eventInfo) => {
          const defaultEvent = { event_name: 'Zolimar Catering & Eventos', banner_url: '/bg-event-1.jpg' };
          res.json({ 
            tables, 
            guests, 
            menuCatalog: menuCatalog || [], 
            eventInfo: eventInfo || defaultEvent 
          });
        });
      });
    });
  });
});

// 4.01 Administrador: Actualizar Nombre del Evento
app.post('/api/admin/event-info/update', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden cambiar el nombre del evento.' });
  const { event_name } = req.body;
  if (!event_name || !event_name.trim()) return res.status(400).json({ error: 'El nombre del evento no puede estar vacío.' });

  db.run(`UPDATE event_info SET event_name = ? WHERE id = 1`, [event_name.trim()], (err) => {
    if (err) return res.status(500).json({ error: 'Error al actualizar el nombre del evento.' });
    io.emit('refresh-data');
    res.json({ success: true, message: 'Nombre del evento actualizado con éxito.' });
  });
});

// 4.02 Administrador: Cargar Imagen Personalizada del Evento (Dropzone/Avatar/Banner)
app.post('/api/admin/event-info/banner-upload', auth, uploadBanner.single('banner'), (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden cambiar la foto del evento.' });
  if (!req.file) return res.status(400).json({ error: 'No se subió ninguna imagen.' });

  const bannerUrl = `/uploads/${req.file.filename}`;
  db.run(`UPDATE event_info SET banner_url = ? WHERE id = 1`, [bannerUrl], (err) => {
    if (err) return res.status(500).json({ error: 'Error al guardar la imagen del evento.' });
    io.emit('refresh-data');
    res.json({ success: true, message: 'Imagen del evento actualizada con éxito.', banner_url: bannerUrl });
  });
});

// 4.1 Administrador: Agregar opción al catálogo del menú del día
app.post('/api/admin/menu-catalog/add', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden gestionar el catálogo del día.' });
  const { category, name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre de la opción es requerido.' });
  const cleanCategory = category === 'drink' ? 'drink' : 'food';
  const cleanName = name.trim();

  db.run(`INSERT INTO menu_catalog (category, name, is_active) VALUES (?, ?, 1)`, [cleanCategory, cleanName], function(err) {
    if (err) return res.status(500).json({ error: 'Error al guardar en catálogo: ' + err.message });
    io.emit('refresh-data');
    res.json({ success: true, message: `Opción '${cleanName}' agregada al catálogo.`, id: this.lastID });
  });
});

// 4.2 Administrador: Actualizar opción del catálogo
app.post('/api/admin/menu-catalog/update', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden editar el catálogo.' });
  const { id, category, name } = req.body;
  if (!id || !name || !name.trim()) return res.status(400).json({ error: 'ID y Nombre requeridos.' });
  const cleanCategory = category === 'drink' ? 'drink' : 'food';

  db.run(`UPDATE menu_catalog SET category = ?, name = ? WHERE id = ?`, [cleanCategory, name.trim(), id], function(err) {
    if (err) return res.status(500).json({ error: 'Error al actualizar catálogo: ' + err.message });
    io.emit('refresh-data');
    res.json({ success: true, message: 'Ítem de la carta actualizado con éxito.' });
  });
});

// 4.3 Administrador: Eliminar opción del catálogo del menú del día
app.post('/api/admin/menu-catalog/delete', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden eliminar opciones del catálogo.' });
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID de opción requerido.' });

  db.run(`DELETE FROM menu_catalog WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: 'Error al eliminar del catálogo.' });
    io.emit('refresh-data');
    res.json({ success: true, message: 'Opción eliminada del catálogo del día.' });
  });
});

// 4.4 Administrador: Agregar nueva Mesa
app.post('/api/admin/tables/add', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden gestionar mesas.' });
  db.get(`SELECT MAX(id) as maxId FROM tables`, (err, row) => {
    const nextId = (row && row.maxId ? row.maxId : 0) + 1;
    db.run(
      `INSERT INTO tables (id, service_status, food_service, drink_service, food_type, drink_type) VALUES (?, 'Pending', 1, 0, 'Menú Estándar', 'Agua & Gaseosa')`,
      [nextId],
      (insertErr) => {
        if (insertErr) return res.status(500).json({ error: 'Error al crear mesa: ' + insertErr.message });
        io.emit('refresh-data');
        res.json({ success: true, message: `Mesa ${nextId} creada con éxito.`, tableId: nextId });
      }
    );
  });
});

// 4.5 Administrador: Quitar/Eliminar última Mesa
app.post('/api/admin/tables/remove', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden gestionar mesas.' });
  const { tableId } = req.body;

  const resolveTarget = (cb) => {
    if (tableId) return cb(null, parseInt(tableId));
    db.get(`SELECT MAX(id) as maxId FROM tables`, (err, row) => cb(err, row?.maxId));
  };

  resolveTarget((err, targetId) => {
    if (err || !targetId) return res.status(400).json({ error: 'No se encontró una mesa para eliminar.' });
    if (targetId <= 1) return res.status(400).json({ error: 'Debe existir al menos 1 mesa en el evento.' });

    // Eliminar comensales asignados a esta mesa y luego eliminar la mesa
    db.run(`DELETE FROM guests WHERE table_id = ?`, [targetId], (guestErr) => {
      db.run(`DELETE FROM tables WHERE id = ?`, [targetId], (delErr) => {
        if (delErr) return res.status(500).json({ error: 'Error al eliminar mesa: ' + delErr.message });
        io.emit('refresh-data');
        res.json({ success: true, message: `Mesa ${targetId} eliminada correctamente.` });
      });
    });
  });
});

// 4.6 Administrador: Ajustar cantidad total de mesas
app.post('/api/admin/tables/set-count', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden gestionar mesas.' });
  const targetCount = parseInt(req.body.count);
  if (!targetCount || targetCount < 1 || targetCount > 100) {
    return res.status(400).json({ error: 'La cantidad de mesas debe estar entre 1 y 100.' });
  }

  db.all(`SELECT id FROM tables ORDER BY id ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const currentCount = rows.length;

    if (targetCount === currentCount) {
      return res.json({ success: true, message: `La cantidad de mesas ya es ${targetCount}.` });
    }

    if (targetCount > currentCount) {
      // Agregar mesas faltantes
      const stmt = db.prepare(`INSERT OR IGNORE INTO tables (id, service_status, food_service, drink_service, food_type, drink_type) VALUES (?, 'Pending', 1, 0, 'Menú Estándar', 'Agua & Gaseosa')`);
      for (let i = currentCount + 1; i <= targetCount; i++) {
        stmt.run([i]);
      }
      stmt.finalize(() => {
        io.emit('refresh-data');
        res.json({ success: true, message: `Se aumentaron las mesas a un total de ${targetCount}.` });
      });
    } else {
      // Quitar mesas sobrantes y limpiar comensales de las mesas removidas
      db.run(`DELETE FROM guests WHERE table_id > ?`, [targetCount], (guestErr) => {
        db.run(`DELETE FROM tables WHERE id > ?`, [targetCount], (delErr) => {
          if (delErr) return res.status(500).json({ error: delErr.message });
          io.emit('refresh-data');
          res.json({ success: true, message: `Se ajustaron las mesas a un total de ${targetCount}.` });
        });
      });
    }
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

  // Asegurar que la mesa exista
  db.run(`INSERT OR IGNORE INTO tables (id, service_status, food_service, drink_service, food_type, drink_type) VALUES (?, 'Pending', 1, 0, 'Menú Estándar', 'Agua & Gaseosa')`, [tableId], () => {
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

// 6.1 Administrador: Vaciar/Eliminar TODA la lista de invitados
app.post('/api/admin/guests/clear-all', auth, (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden vaciar la lista de invitados.' });

  db.all(`SELECT * FROM guests`, (err, prevGuests) => {
    db.run(
      `INSERT INTO audit_logs (user_name, action, details) VALUES (?, 'CLEAR_ALL_GUESTS', ?)`,
      [req.user.name, JSON.stringify(prevGuests || [])]
    );

    db.run(`DELETE FROM guests`, (delErr) => {
      if (delErr) return res.status(500).json({ error: 'Error al vaciar la lista de invitados: ' + delErr.message });
      db.run(`UPDATE tables SET service_status = 'Pending'`, () => {});
      io.emit('refresh-data');
      res.json({ success: true, message: 'La lista de comensales ha sido vaciada completamente.' });
    });
  });
});

// 7. Subir Excel / CSV (Reemplazar o Agregar)
app.post('/api/guests/upload', auth, upload.single('file'), (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Solo los administradores pueden cargar listas de Excel.' });
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

  const mode = req.body.mode === 'append' ? 'append' : 'replace';

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
        db.run(`INSERT INTO audit_logs (user_name, action, details) VALUES (?, ?, ?)`, 
          [req.user.name, mode === 'replace' ? 'IMPORT_REPLACE_GUESTS' : 'IMPORT_APPEND_GUESTS', JSON.stringify(prevGuests || [])]);
      });

      const doInsert = () => {
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

          // Asegurar que la mesa exista en la tabla tables
          db.run(`INSERT OR IGNORE INTO tables (id, service_status, food_service, drink_service, food_type, drink_type) VALUES (?, 'Pending', 1, 0, 'Menú Estándar', 'Agua & Gaseosa')`, [tableNum], () => {});

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
            const modeText = mode === 'replace' ? 'reemplazando la lista anterior' : 'agregados a los existentes';
            res.json({ message: `¡Éxito! Se importaron ${importedCount} comensales (${modeText}).` });
          });
        });
      };

      db.run('BEGIN TRANSACTION', () => {
        if (mode === 'replace') {
          db.run(`DELETE FROM guests`, () => {
            db.run(`UPDATE tables SET service_status = 'Pending'`, () => {
              doInsert();
            });
          });
        } else {
          doInsert();
        }
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

    // SEGURIDAD: Bloquear modificación si el servicio ya fue confirmado y el usuario es MESERO
    if (currentGuest.food_served === 1 && currentGuest.drink_served === 1 && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'El servicio ya fue confirmado. Solo un administrador puede modificarlo.' });
    }

    const newFoodServed = food_served !== undefined ? (food_served ? 1 : 0) : currentGuest.food_served;
    const newDrinkServed = drink_served !== undefined ? (drink_served ? 1 : 0) : currentGuest.drink_served;
    const newDietary = dietary !== undefined ? dietary : currentGuest.dietary;
    const newTag = tag !== undefined ? tag : currentGuest.tag;

    // Si se especifica un estado explícito ('Pending', 'In Progress', 'Served'), se utiliza ese.
    // De lo contrario, se calcula automáticamente según las entregas.
    let newStatus;
    if (status && ['Pending', 'In Progress', 'Served'].includes(status)) {
      newStatus = status;
    } else if (newFoodServed === 1 && newDrinkServed === 1) {
      newStatus = 'Served';
    } else if (newFoodServed === 1 || newDrinkServed === 1) {
      newStatus = 'In Progress';
    } else {
      newStatus = 'Pending';
    }

    db.run(
      `UPDATE guests SET status = ?, food_served = ?, drink_served = ?, dietary = ?, tag = ? WHERE id = ?`,
      [newStatus, newFoodServed, newDrinkServed, newDietary, newTag, guestId],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: 'Error actualizando estado del invitado' });

        // Recalcular el estado general de la mesa automáticamente desde sus invitados
        db.all(`SELECT status, food_served, drink_served FROM guests WHERE table_id = ?`, [currentGuest.table_id], (err2, tableGuests) => {
          if (!err2 && tableGuests && tableGuests.length > 0) {
            const allServed = tableGuests.every(g => g.status === 'Served' || (g.food_served === 1 && g.drink_served === 1));
            const anyServed = tableGuests.some(g => g.status === 'Served' || g.status === 'In Progress' || g.food_served === 1 || g.drink_served === 1);
            const tableStatus = allServed ? 'Served' : anyServed ? 'In Progress' : 'Pending';
            db.run(`UPDATE tables SET service_status = ? WHERE id = ?`, [tableStatus, currentGuest.table_id], () => {
              io.emit('refresh-data');
              res.json({ success: true, guest: { id: guestId, status: newStatus, food_served: newFoodServed, drink_served: newDrinkServed } });
            });
          } else {
            io.emit('refresh-data');
            res.json({ success: true, guest: { id: guestId, status: newStatus, food_served: newFoodServed, drink_served: newDrinkServed } });
          }
        });
      }
    );
  });
});

// 9.1 Módulo de Corrección para el Mesero: Modificar Pedido / Servicio en Tiempo Real
app.post('/api/waiter/order/update', auth, (req, res) => {
  const { guestId, dietary, notes, food_served, drink_served, status, pin } = req.body;
  if (!guestId) return res.status(400).json({ error: 'ID de invitado requerido' });

  db.get(`SELECT * FROM guests WHERE id = ?`, [guestId], (err, currentGuest) => {
    if (err || !currentGuest) return res.status(404).json({ error: 'Invitado no encontrado' });

    // Permisos y Lógica de Modificación:
    // Si el pedido ya fue marcado como Servido y el usuario es MESERO, exige la clave PIN '1234'
    const isFullyServed = currentGuest.food_served === 1 && currentGuest.drink_served === 1;
    const isWaiter = req.user.role !== 'ADMIN';

    if (isFullyServed && isWaiter) {
      if (!pin || pin.trim() !== '1234') {
        return res.status(403).json({ error: 'Este pedido ya fue entregado. Ingrese el PIN de Autorización (1234) o solicite la clave del Administrador.' });
      }
    }

    const newFoodServed = food_served !== undefined ? (food_served ? 1 : 0) : currentGuest.food_served;
    const newDrinkServed = drink_served !== undefined ? (drink_served ? 1 : 0) : currentGuest.drink_served;
    const newDietary = dietary !== undefined ? dietary : currentGuest.dietary;
    const newNotes = notes !== undefined ? notes.trim() : (currentGuest.notes || '');

    let newStatus = status;
    if (!newStatus || !['Pending', 'In Progress', 'Served'].includes(newStatus)) {
      if (newFoodServed === 1 && newDrinkServed === 1) newStatus = 'Served';
      else if (newFoodServed === 1 || newDrinkServed === 1) newStatus = 'In Progress';
      else newStatus = 'Pending';
    }

    const tagStr = newDietary.toLowerCase().includes('vege') ? 'Vegetarian' : (newDietary.toLowerCase().includes('vega') ? 'Vegano' : 'Standard');

    db.run(
      `UPDATE guests SET status = ?, food_served = ?, drink_served = ?, dietary = ?, notes = ?, tag = ? WHERE id = ?`,
      [newStatus, newFoodServed, newDrinkServed, newDietary, newNotes, tagStr, guestId],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: 'Error actualizando pedido del invitado: ' + updateErr.message });

        // Audit Log
        db.run(`INSERT INTO audit_logs (user_name, action, details) VALUES (?, 'EDIT_ORDER', ?)`, 
          [req.user.name, `Modificación de pedido (Mesa ${currentGuest.table_id}, Silla ${currentGuest.seat}): ${newDietary} [Notas: ${newNotes}]`]);

        // Recalcular estado de la mesa y emitir Socket.io
        db.all(`SELECT status, food_served, drink_served FROM guests WHERE table_id = ?`, [currentGuest.table_id], (err2, tableGuests) => {
          if (!err2 && tableGuests && tableGuests.length > 0) {
            const allServed = tableGuests.every(g => g.status === 'Served' || (g.food_served === 1 && g.drink_served === 1));
            const anyServed = tableGuests.some(g => g.status === 'Served' || g.status === 'In Progress' || g.food_served === 1 || g.drink_served === 1);
            const tableStatus = allServed ? 'Served' : anyServed ? 'In Progress' : 'Pending';
            db.run(`UPDATE tables SET service_status = ? WHERE id = ?`, [tableStatus, currentGuest.table_id], () => {
              io.emit('refresh-data');
              res.json({ success: true, message: 'Pedido modificado exitosamente en tiempo real', guest: { id: guestId, status: newStatus, food_served: newFoodServed, drink_served: newDrinkServed, notes: newNotes } });
            });
          } else {
            io.emit('refresh-data');
            res.json({ success: true, message: 'Pedido modificado exitosamente en tiempo real', guest: { id: guestId, status: newStatus, food_served: newFoodServed, drink_served: newDrinkServed, notes: newNotes } });
          }
        });
      }
    );
  });
});

// 10. Cambiar Detalles del Servicio de Mesa (Comida y Bebida) — service_status calculado automáticamente
app.post('/api/tables/status', auth, (req, res) => {
  const { tableId, foodService, drinkService, foodType, drinkType } = req.body;
  if (!tableId) return res.status(400).json({ error: 'Parámetro tableId requerido' });

  // SEGURIDAD: Solo ADMIN puede definir el tipo de menú y bebida
  if ((foodType !== undefined || drinkType !== undefined) && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Solo el Administrador puede definir el tipo de menú y bebida.' });
  }

  db.get(`SELECT * FROM tables WHERE id = ?`, [tableId], (err, currentTable) => {
    if (err || !currentTable) return res.status(404).json({ error: 'Mesa no encontrada' });

    const newFoodService = foodService !== undefined ? (foodService ? 1 : 0) : currentTable.food_service;
    const newDrinkService = drinkService !== undefined ? (drinkService ? 1 : 0) : currentTable.drink_service;
    const newFoodType = foodType !== undefined ? foodType : (currentTable.food_type || 'Menú Estándar');
    const newDrinkType = drinkType !== undefined ? drinkType : (currentTable.drink_type || 'Agua & Gaseosa');

    // Calcular service_status AUTOMÁTICAMENTE desde el estado real de los invitados de la mesa
    db.all(`SELECT food_served, drink_served FROM guests WHERE table_id = ?`, [tableId], (err2, tableGuests) => {
      let newServiceStatus = currentTable.service_status;
      if (!err2 && tableGuests) {
        if (tableGuests.length === 0) {
          newServiceStatus = 'Pending';
        } else {
          const allServed = tableGuests.every(g => g.food_served === 1 && g.drink_served === 1);
          const anyServed = tableGuests.some(g => g.food_served === 1 || g.drink_served === 1);
          newServiceStatus = allServed ? 'Served' : anyServed ? 'In Progress' : 'Pending';
        }
      }

      db.run(
        `UPDATE tables SET service_status = ?, food_service = ?, drink_service = ?, food_type = ?, drink_type = ? WHERE id = ?`,
        [newServiceStatus, newFoodService, newDrinkService, newFoodType, newDrinkType, tableId],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: 'Error actualizando mesa: ' + updateErr.message });
          io.emit('refresh-data');
          res.json({ success: true, service_status: newServiceStatus });
        }
      );
    });
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
