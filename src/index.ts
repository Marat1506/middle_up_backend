import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();

const corsOptions = {
  origin: [
    'https://middle-up-frontend.vercel.app',
    'http://localhost:3000', 
    'http://localhost:5173',
    /\.vercel\.app$/,
    /\.netlify\.app$/
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// Обработка preflight запросов
app.options('*', cors(corsOptions));

interface Item {
  id: number;
  name: string;
}

interface SelectedItem extends Item {
  order: number;
}

const allItems: Map<number, Item> = new Map();
const selectedItems: Map<number, SelectedItem> = new Map();
let nextId = 1000001;
let nextOrder = 0;

console.log('Инициализация 1,000,000 элементов...');
for (let i = 1; i <= 1000000; i++) {
  allItems.set(i, { id: i, name: `Element ${i}` });
}
console.log(`Создано ${allItems.size} элементов`);

interface QueuedRequest {
  type: 'add' | 'select' | 'unselect' | 'reorder';
  data: any;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timestamp: number;
  key: string;
}

const addQueue: QueuedRequest[] = [];
const operationQueue: QueuedRequest[] = [];

function queueAddRequest(name: string): Promise<Item> {
  return new Promise((resolve, reject) => {
    const key = name.trim().toLowerCase();
    
    const existingRequest = addQueue.find(req => req.key === key);
    if (existingRequest) {
      const originalResolve = existingRequest.resolve;
      existingRequest.resolve = (value: any) => {
        originalResolve(value);
        resolve(value);
      };
      return;
    }
    
    const request: QueuedRequest = {
      type: 'add',
      data: { name },
      resolve,
      reject,
      timestamp: Date.now(),
      key
    };
    
    addQueue.push(request);
    console.log(`Добавлен в очередь: ${name}, размер очереди: ${addQueue.length}`);
  });
}

function queueOperation(type: 'select' | 'unselect' | 'reorder', key: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // Для операций unselect не делаем дедупликацию, так как они должны выполняться всегда
    if (type === 'unselect') {
      const request: QueuedRequest = {
        type,
        data,
        resolve,
        reject,
        timestamp: Date.now(),
        key: `${key}:${Date.now()}` // Уникальный ключ для каждого запроса
      };
      
      operationQueue.push(request);
      console.log(`Операция в очереди: ${type}, ключ: ${request.key}`);
      return;
    }
    
    // Для остальных операций оставляем дедупликацию
    const existingRequest = operationQueue.find(req => req.key === key);
    if (existingRequest) {
      const originalResolve = existingRequest.resolve;
      existingRequest.resolve = (value: any) => {
        originalResolve(value);
        resolve(value);
      };
      return;
    }
    
    const request: QueuedRequest = {
      type,
      data,
      resolve,
      reject,
      timestamp: Date.now(),
      key
    };
    
    operationQueue.push(request);
    console.log(`Операция в очереди: ${type}, ключ: ${key}`);
  });
}

setInterval(() => {
  if (addQueue.length === 0) return;
  
  console.log(`Обработка ${addQueue.length} запросов на добавление`);
  const requests = [...addQueue];
  addQueue.length = 0;
  
  for (const req of requests) {
    try {
      const newItem = { id: nextId++, name: req.data.name };
      allItems.set(newItem.id, newItem);
      req.resolve(newItem);
      console.log(`Добавлен элемент: ID ${newItem.id}, название: ${newItem.name}`);
    } catch (error) {
      req.reject(error);
    }
  }
}, 10000);

setInterval(() => {
  if (operationQueue.length === 0) return;
  
  console.log(`Обработка ${operationQueue.length} операций`);
  const requests = [...operationQueue];
  operationQueue.length = 0;
  
  for (const req of requests) {
    try {
      if (req.type === 'select') {
        const id = req.data.id;
        const item = allItems.get(id);
        if (item && !selectedItems.has(id)) {
          const selected: SelectedItem = { ...item, order: nextOrder++ };
          selectedItems.set(id, selected);
          req.resolve(selected);
          console.log(`Выбран элемент: ID ${id}`);
        } else if (selectedItems.has(id)) {
          req.resolve(selectedItems.get(id));
        } else {
          req.reject(new Error('Item not found'));
        }
      } else if (req.type === 'unselect') {
        const id = req.data.id;
        if (selectedItems.has(id)) {
          selectedItems.delete(id);
          console.log(`Отменен выбор элемента: ID ${id}`);
        }
        req.resolve({ success: true });
      } else if (req.type === 'reorder') {
        const { itemIds } = req.data;
        for (let i = 0; i < itemIds.length; i++) {
          const id = itemIds[i];
          const item = selectedItems.get(id);
          if (item) {
            item.order = i;
            selectedItems.set(id, item);
          }
        }
        console.log(`Переупорядочены элементы: ${itemIds.join(', ')}`);
        req.resolve({ success: true });
      }
    } catch (error) {
      console.error(`Ошибка обработки операции ${req.type}:`, error);
      req.reject(error);
    }
  }
}, 1000);

app.get('/api/items', async (req: Request, res: Response) => {
  try {
    const filterParam = req.query.filter;
    const pageParam = req.query.page;
    
    const filter = (typeof filterParam === 'string' ? filterParam : '').toLowerCase();
    const page = parseInt(typeof pageParam === 'string' ? pageParam : '0') || 0;
    const limit = 20;
    
    console.log(`Запрос элементов: фильтр="${filter}", страница=${page}`);
    
    const items: Item[] = [];
    const filteredItems: Item[] = [];
    
    const ids = Array.from(allItems.keys()).sort((a, b) => a - b);
    
    // Сначала собираем все подходящие элементы (не выбранные и соответствующие фильтру)
    for (const id of ids) {
      if (selectedItems.has(id)) continue;
      
      const item = allItems.get(id)!;
      const matchesFilter = !filter || 
        item.name.toLowerCase().includes(filter) || 
        item.id.toString().includes(filter);
      
      if (matchesFilter) {
        filteredItems.push(item);
      }
    }
    
    // Теперь применяем пагинацию
    const startIndex = page * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = filteredItems.slice(startIndex, endIndex);
    
    console.log(`Найдено ${paginatedItems.length} элементов на странице ${page} из ${filteredItems.length} общих`);
    res.json({ items: paginatedItems, total: filteredItems.length });
  } catch (error) {
    console.error('Ошибка получения элементов:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/selected', async (req: Request, res: Response) => {
  try {
    const filterParam = req.query.filter;
    const pageParam = req.query.page;
    
    const filter = (typeof filterParam === 'string' ? filterParam : '').toLowerCase();
    const page = parseInt(typeof pageParam === 'string' ? pageParam : '0') || 0;
    const limit = 20;
    
    console.log(`Запрос выбранных элементов: фильтр="${filter}", страница=${page}`);
    
    const sortedItems = Array.from(selectedItems.values())
      .sort((a, b) => a.order - b.order);
    
    // Фильтруем элементы
    const filteredItems = sortedItems.filter(item => {
      return !filter || 
        item.name.toLowerCase().includes(filter) || 
        item.id.toString().includes(filter);
    });
    
    // Применяем пагинацию
    const startIndex = page * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = filteredItems.slice(startIndex, endIndex);
    
    console.log(`Найдено ${paginatedItems.length} выбранных элементов на странице ${page} из ${filteredItems.length} общих`);
    res.json({ items: paginatedItems, total: filteredItems.length });
  } catch (error) {
    console.error('Ошибка получения выбранных элементов:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/items', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    console.log(`Запрос на добавление элемента: ${name}`);
    const item = await queueAddRequest(name.trim());
    res.json(item);
  } catch (error) {
    console.error('Ошибка добавления элемента:', error);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

app.post('/api/select/:id', async (req: Request, res: Response) => {
  try {
    const idParam = req.params.id;
    const id = parseInt(typeof idParam === 'string' ? idParam : '0');
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    
    console.log(`Запрос на выбор элемента: ID ${id}`);
    const selected = await queueOperation('select', `select:${id}`, { id });
    res.json(selected);
  } catch (error) {
    console.error('Ошибка выбора элемента:', error);
    res.status(404).json({ error: 'Item not found' });
  }
});

app.delete('/api/select/:id', async (req: Request, res: Response) => {
  try {
    const idParam = req.params.id;
    const id = parseInt(typeof idParam === 'string' ? idParam : '0');
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    
    console.log(`Запрос на отмену выбора элемента: ID ${id}`);
    
    // Проверяем, что элемент действительно выбран
    if (!selectedItems.has(id)) {
      console.log(`Элемент ${id} уже не выбран`);
      return res.json({ success: true });
    }
    
    const result = await queueOperation('unselect', `unselect:${id}`, { id });
    res.json(result);
  } catch (error) {
    console.error('Ошибка отмены выбора элемента:', error);
    res.status(500).json({ error: 'Failed to unselect item' });
  }
});

app.put('/api/reorder', async (req: Request, res: Response) => {
  try {
    const { itemIds } = req.body as { itemIds: number[] };
    if (!Array.isArray(itemIds)) {
      return res.status(400).json({ error: 'itemIds must be an array' });
    }
    
    console.log(`Запрос на переупорядочивание: ${itemIds.length} элементов`);
    const result = await queueOperation('reorder', `reorder:${Date.now()}`, { itemIds });
    res.json(result);
  } catch (error) {
    console.error('Ошибка переупорядочивания:', error);
    res.status(500).json({ error: 'Failed to reorder items' });
  }
});

app.get('/api/state', (req: Request, res: Response) => {
  try {
    const selectedIds = Array.from(selectedItems.keys());
    const selectedOrder = Array.from(selectedItems.values())
      .sort((a, b) => a.order - b.order)
      .map(item => item.id);
    
    console.log(`Запрос состояния: ${selectedIds.length} выбранных элементов`);
    res.json({
      selectedIds,
      selectedOrder,
      nextId,
      nextOrder,
      totalItems: allItems.size,
      selectedCount: selectedItems.size
    });
  } catch (error) {
    console.error('Ошибка получения состояния:', error);
    res.status(500).json({ error: 'Failed to get state' });
  }
});

app.post('/api/state', (req: Request, res: Response) => {
  try {
    const { selectedIds, selectedOrder } = req.body;
    
    console.log('Восстановление состояния...');
    selectedItems.clear();
    nextOrder = 0;
    
    if (selectedOrder && Array.isArray(selectedOrder)) {
      for (let i = 0; i < selectedOrder.length; i++) {
        const id = selectedOrder[i];
        const item = allItems.get(id);
        if (item) {
          const selected: SelectedItem = { ...item, order: i };
          selectedItems.set(id, selected);
          nextOrder = i + 1;
        }
      }
    }
    
    console.log(`Восстановлено ${selectedItems.size} выбранных элементов`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка восстановления состояния:', error);
    res.status(500).json({ error: 'Failed to restore state' });
  }
});

app.get('/api/stats', (req: Request, res: Response) => {
  res.json({
    totalItems: allItems.size,
    selectedItems: selectedItems.size,
    addQueueSize: addQueue.length,
    operationQueueSize: operationQueue.length,
    nextId,
    nextOrder
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});