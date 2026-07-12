/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import PDFDocument from 'pdfkit';
import fs from 'node:fs';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Parse JSON request bodies
app.use(express.json());

// In-memory model interfaces
interface User {
  id: string;
  email: string;
  name: string;
  wallet_balance: number; // in USD
  created_at: string;
}

interface WalletDeposit {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  amount: number;
  currency: string;
  receipt_number: string;
  receipt_img: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at?: string;
}

interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

interface LocalOrder {
  id: string; // Duffel order ID
  booking_reference: string;
  total_amount: string;
  total_currency: string;
  payment_status: string;
  payment_required_by: string | null;
  passengers: Record<string, unknown>[];
  route: string;
  owner_name: string;
  status: 'awaiting_payment' | 'confirmed' | 'cancelled';
  created_at: string;
  tickets?: Record<string, string>[];
  // Added fields for Wallet & Hold features
  user_id?: string;
  receipt_number?: string;
  receipt_img?: string;
  admin_review_status?: 'pending_receipt' | 'pending_approval' | 'approved' | 'rejected';
  is_hold_booking?: boolean;
  markup_percentage_at_booking?: number;
  office_markup_amount?: number;
  office_total_amount?: number;
  base_amount?: string;
  tax_amount?: string;
}

interface Settings {
  office_markup_percentage: number;
}

const appSettings: Settings = {
  office_markup_percentage: 5 // Default 5% markup
};

// In-memory collections with high quality mock seed data
const users: User[] = [
  {
    id: 'usr_ahmed',
    email: 'ahmed.devfree@gmail.com',
    name: 'أحمد الخطيب',
    wallet_balance: 1500.00,
    created_at: new Date().toISOString()
  }
];

const deposits: WalletDeposit[] = [
  {
    id: 'dep_01',
    user_id: 'usr_ahmed',
    user_name: 'أحمد الخطيب',
    user_email: 'ahmed.devfree@gmail.com',
    amount: 500.00,
    currency: 'USD',
    receipt_number: 'REC-9018237198',
    receipt_img: 'mock_receipt_image_base64_data_here',
    status: 'approved',
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(), // 1 day ago
    reviewed_at: new Date(Date.now() - 3600000 * 23).toISOString()
  },
  {
    id: 'dep_02',
    user_id: 'usr_ahmed',
    user_name: 'أحمد الخطيب',
    user_email: 'ahmed.devfree@gmail.com',
    amount: 1000.00,
    currency: 'USD',
    receipt_number: 'REC-3849102374',
    receipt_img: 'mock_receipt_image_base64_data_here_2',
    status: 'pending',
    created_at: new Date(Date.now() - 3600000 * 2).toISOString() // 2 hours ago
  }
];

const notifications: Notification[] = [
  {
    id: 'notif_01',
    user_id: 'usr_ahmed',
    title: 'تم تفعيل المحفظة',
    message: 'مرحباً بك في محفظة برق. يمكنك الآن شحن رصيدك عبر التحويل البنكي وحجز رحلاتك.',
    read: false,
    created_at: new Date(Date.now() - 3600000 * 24).toISOString()
  },
  {
    id: 'notif_02',
    user_id: 'usr_ahmed',
    title: 'موافقة على إيداع رصيد',
    message: 'تمت الموافقة بنجاح على عملية الإيداع بقيمة $500.00 USD وتم شحن محفظتك.',
    read: true,
    created_at: new Date(Date.now() - 3600000 * 23).toISOString()
  }
];

const orders: LocalOrder[] = [];

// Middleware helper to resolve active user from 'X-User-Id' header
function getActiveUser(req: express.Request): User {
  const userId = req.headers['x-user-id'] as string;
  const user = users.find(u => u.id === userId);
  if (user) {
    return user;
  }
  // Default fallback user so that preview and direct access always work gracefully
  return users[0];
}

const DUFFEL_TOKEN = process.env['DUFFEL_TOKEN'] || 'duffel_test_ty_pWH_-s0APUB0Qm50iPFXoEByKc0LgqWZ6qHBc9bJ';

const duffelHeaders = {
  'Authorization': `Bearer ${DUFFEL_TOKEN}`,
  'Duffel-Version': 'v2',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

interface DuffelError extends Error {
  status?: number;
  code?: string;
  title?: string;
  type?: string;
}

// Helper to handle Duffel API responses and errors
async function fetchDuffel(endpoint: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const url = `https://api.duffel.com${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...duffelHeaders,
      ...options.headers
    }
  });

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  
  if (!response.ok) {
    const rawErrors = (json['errors'] || []) as Record<string, unknown>[];
    const errorDetails = rawErrors[0] || {};
    const error = new Error((errorDetails['message'] as string) || `Duffel API error (${response.status})`) as DuffelError;
    error.status = response.status;
    error.code = errorDetails['code'] as string;
    error.title = errorDetails['title'] as string;
    error.type = errorDetails['type'] as string;
    throw error;
  }

  return json;
}
// Fetch ALL orders directly from Duffel (source of truth), handling pagination
async function fetchAllDuffelOrders(): Promise<Record<string, unknown>[]> {
  let allOrders: Record<string, unknown>[] = [];
  let after: string | null = null;

  do {
    const params = new URLSearchParams({ limit: '50', sort: '-created_at' });
    if (after) params.set('after', after);

    const response = await fetchDuffel(`/air/orders?${params.toString()}`);
    const pageData = (response['data'] || []) as Record<string, unknown>[];
    allOrders = allOrders.concat(pageData);

    const meta = response['meta'] as { after?: string | null } | undefined;
    after = meta?.after || null;
  } while (after);

  return allOrders;
}
interface DuffelPassengerRaw {
  given_name: string;
  family_name: string;
  ticket?: { ticket_number: string };
  tickets?: { ticket_number: string }[];
}

interface DuffelOfferRaw {
  id: string;
  total_amount: string;
  total_currency: string;
  owner?: { name: string; logo_symbol_url?: string };
  slices: unknown[];
  payment_requirements?: { requires_instant_payment?: boolean };
}

interface DuffelOfferRequestResponse {
  id: string;
  passengers: unknown[];
  offers: DuffelOfferRaw[];
}

interface DuffelOrderResponse {
  id: string;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
  payment_status: string;
  payment_required_by: string | null;
  passengers: DuffelPassengerRaw[];
  base_amount?: string;
  tax_amount?: string;
}

interface DuffelFullOrderDetails {
  id: string;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
  payment_status: string;
  payment_required_by: string | null;
  status?: string;
  slices?: unknown[];
  owner?: {
    name: string;
    logo_symbol_url?: string;
  };
  passengers?: unknown[];
  documents?: unknown[];
  conditions?: unknown;
  available_actions?: string[];
  base_amount?: string;
  tax_amount?: string;
}

interface DuffelCancellationResponse {
  id: string;
}

/**
 * 1. POST /api/search -> POST /air/offer_requests
 */
app.post('/api/search', async (req, res) => {
  try {
    const { origin, destination, departure_date, cabin_class, passengers } = req.body as { origin?: string; destination?: string; departure_date?: string; cabin_class?: string; passengers?: unknown[] };
    if (!origin || !destination || !departure_date) {
      res.status(400).json({ error: 'الأصل والوجهة وتاريخ المغادرة مطلوبة.' });
      return;
    }

    const payload = {
      data: {
        slices: [
          {
            origin,
            destination,
            departure_date
          }
        ],
        passengers: passengers || [{ type: 'adult' }],
        cabin_class: cabin_class || 'economy'
      }
    };

    const duffelResponse = await fetchDuffel('/air/offer_requests', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const offerRequest = (duffelResponse['data'] || {}) as DuffelOfferRequestResponse;
    const rawOffers = (offerRequest.offers || []) as DuffelOfferRaw[];
    
    const offers = rawOffers.map((offer: DuffelOfferRaw) => ({
      id: offer.id,
      total_amount: offer.total_amount,
      total_currency: offer.total_currency,
      owner: offer.owner || { name: 'Unknown Airline' },
      slices: offer.slices,
      requires_instant_payment: offer.payment_requirements?.requires_instant_payment ?? true,
      hold_supported: !offer.payment_requirements?.requires_instant_payment
    }));

    res.json({
      offer_request_id: offerRequest.id,
      passengers: offerRequest.passengers,
      offers
    });
  } catch (err: unknown) {
    console.error('Duffel Search Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code,
      title: error.title
    });
  }
});

/**
 * 2. GET /api/offers/:offer_id -> GET /air/offers/:offer_id
 */
app.get('/api/offers/:offer_id', async (req, res) => {
  try {
    const { offer_id } = req.params;
    const duffelResponse = await fetchDuffel(`/air/offers/${offer_id}`);
    res.json(duffelResponse['data']);
  } catch (err: unknown) {
    console.error('Duffel Offer Get Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code
    });
  }
});

/**
 * 1. POST /api/auth/login
 */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان.' });
    return;
  }

  // Find user by email or check mock credentials
  let user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    // For trial, auto-register them with a mock balance if they don't exist
    user = {
      id: 'usr_' + Math.random().toString(36).substr(2, 9),
      email: email.toLowerCase(),
      name: email.split('@')[0],
      wallet_balance: 500.00, // Give some starter trial balance
      created_at: new Date().toISOString()
    };
    users.push(user);
    
    // Add starter notification
    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: user.id,
      title: 'مرحباً بك في برق!',
      message: 'تم إنشاء حسابك بنجاح ومنحك رصيداً ترحيبياً بقيمة $500.00 في محفظتك الإلكترونية.',
      read: false,
      created_at: new Date().toISOString()
    });
  }

  res.json({
    success: true,
    user
  });
});

/**
 * 2. POST /api/auth/register
 */
app.post('/api/auth/register', (req, res) => {
  const { email, name, password } = req.body as { email?: string; name?: string; password?: string };
  if (!email || !name || !password) {
    res.status(400).json({ error: 'جميع الحقول مطلوبة لإنشاء الحساب.' });
    return;
  }

  const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    res.status(400).json({ error: 'البريد الإلكتروني مسجل بالفعل.' });
    return;
  }

  const user: User = {
    id: 'usr_' + Math.random().toString(36).substr(2, 9),
    email: email.toLowerCase(),
    name,
    wallet_balance: 0, // Starts at 0, must deposit
    created_at: new Date().toISOString()
  };

  users.push(user);

  notifications.push({
    id: 'notif_' + Math.random().toString(36).substr(2, 9),
    user_id: user.id,
    title: 'مرحباً بك في عائلة برق',
    message: 'تم تسجيل حسابك بنجاح. يمكنك شحن محفظتك الآن للبدء بحجز رحلات الطيران الفورية.',
    read: false,
    created_at: new Date().toISOString()
  });

  res.json({
    success: true,
    user
  });
});

/**
 * 3. GET /api/user/profile
 */
app.get('/api/user/profile', (req, res) => {
  const user = getActiveUser(req);
  res.json(user);
});

/**
 * 4. GET /api/user/notifications
 */
app.get('/api/user/notifications', (req, res) => {
  const user = getActiveUser(req);
  const userNotifs = notifications.filter(n => n.user_id === user.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json(userNotifs);
});

/**
 * 5. POST /api/user/notifications/:id/read
 */
app.post('/api/user/notifications/:id/read', (req, res) => {
  const { id } = req.params;
  const notif = notifications.find(n => n.id === id);
  if (notif) {
    notif.read = true;
  }
  res.json({ success: true });
});

/**
 * 6. POST /api/wallet/deposit
 */
app.post('/api/wallet/deposit', (req, res) => {
  const user = getActiveUser(req);
  const { amount, receipt_number, receipt_img } = req.body as { amount?: number; receipt_number?: string; receipt_img?: string };

  if (!amount || amount <= 0 || !receipt_number) {
    res.status(400).json({ error: 'المبلغ ورقم التحويل/الإيصال مطلوبان.' });
    return;
  }

  const newDeposit: WalletDeposit = {
    id: 'dep_' + Math.random().toString(36).substr(2, 9),
    user_id: user.id,
    user_name: user.name,
    user_email: user.email,
    amount: Number(amount),
    currency: 'USD',
    receipt_number,
    receipt_img: receipt_img || 'default_receipt_icon_or_path',
    status: 'pending',
    created_at: new Date().toISOString()
  };

  deposits.push(newDeposit);

  // Notify user that we are reviewing it
  notifications.push({
    id: 'notif_' + Math.random().toString(36).substr(2, 9),
    user_id: user.id,
    title: 'جاري مراجعة طلب الإيداع',
    message: `طلب شحن الرصيد بقيمة $${amount} USD تحت المراجعة الآن من قبل الإدارة وسيتم تحديث رصيدك فور الموافقة.`,
    read: false,
    created_at: new Date().toISOString()
  });

  res.json({
    success: true,
    deposit: newDeposit
  });
});

/**
 * 7. GET /api/admin/deposits
 */
app.get('/api/admin/deposits', (req, res) => {
  // Return all deposits for admin review
  res.json(deposits.sort((a, b) => b.created_at.localeCompare(a.created_at)));
});

/**
 * 8. POST /api/admin/deposits/:id/approve
 */
app.post('/api/admin/deposits/:id/approve', (req, res) => {
  const { id } = req.params;
  const deposit = deposits.find(d => d.id === id);
  if (!deposit) {
    res.status(404).json({ error: 'طلب الإيداع غير موجود.' });
    return;
  }

  if (deposit.status !== 'pending') {
    res.status(400).json({ error: 'تمت معالجة هذا الطلب بالفعل.' });
    return;
  }

  deposit.status = 'approved';
  deposit.reviewed_at = new Date().toISOString();

  // Credit user's wallet
  const user = users.find(u => u.id === deposit.user_id);
  if (user) {
    user.wallet_balance += deposit.amount;
    
    // Send success notification to user
    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: user.id,
      title: 'تم شحن رصيدك بنجاح ✅',
      message: `تمت الموافقة على تحويلك البنكي، وشحن محفظتك بقيمة $${deposit.amount} USD بنجاح. رصيدك الحالي هو $${user.wallet_balance.toFixed(2)} USD.`,
      read: false,
      created_at: new Date().toISOString()
    });
  }

  res.json({ success: true, deposit });
});

/**
 * 9. POST /api/admin/deposits/:id/reject
 */
app.post('/api/admin/deposits/:id/reject', (req, res) => {
  const { id } = req.params;
  const deposit = deposits.find(d => d.id === id);
  if (!deposit) {
    res.status(404).json({ error: 'طلب الإيداع غير موجود.' });
    return;
  }

  if (deposit.status !== 'pending') {
    res.status(400).json({ error: 'تمت معالجة هذا الطلب بالفعل.' });
    return;
  }

  deposit.status = 'rejected';
  deposit.reviewed_at = new Date().toISOString();

  // Notify user of rejection
  notifications.push({
    id: 'notif_' + Math.random().toString(36).substr(2, 9),
    user_id: deposit.user_id,
    title: 'طلب الإيداع مرفوض ❌',
    message: `تم رفض تحويلك البنكي رقم ${deposit.receipt_number} بقيمة $${deposit.amount} USD لعدم تطابق البيانات أو إيصال غير صالح. يرجى التواصل مع الدعم الفني.`,
    read: false,
    created_at: new Date().toISOString()
  });

  res.json({ success: true, deposit });
});

/**
 * 10. POST /api/orders/hold -> POST /air/orders (type = "hold")
 */
app.post('/api/orders/hold', async (req, res) => {
  try {
    const user = getActiveUser(req);
    const { offer_id, passengers, route_summary, owner_name } = req.body as { offer_id?: string; passengers?: Record<string, unknown>[]; route_summary?: string; owner_name?: string };
    if (!offer_id || !passengers) {
      res.status(400).json({ error: 'offer_id matches and passenger details are required' });
      return;
    }

    // Call Duffel to create hold order
    const payload = {
      data: {
        type: 'hold',
        selected_offers: [offer_id],
        passengers
      }
    };

    const duffelResponse = await fetchDuffel('/air/orders', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const duffelOrder = (duffelResponse['data'] || {}) as DuffelOrderResponse;

    const markupPct = appSettings.office_markup_percentage;
    const duffelTotal = Number(duffelOrder.total_amount || 0);
    const office_markup_amount = Number((duffelTotal * (markupPct / 100)).toFixed(2));
    const office_total_amount = Number((duffelTotal + office_markup_amount).toFixed(2));
    const base_amount = duffelOrder.base_amount || (duffelTotal * 0.85).toFixed(2);
    const tax_amount = duffelOrder.tax_amount || (duffelTotal * 0.15).toFixed(2);

    const newOrder: LocalOrder = {
      id: duffelOrder.id,
      booking_reference: duffelOrder.booking_reference,
      total_amount: duffelOrder.total_amount,
      total_currency: duffelOrder.total_currency,
      payment_status: duffelOrder.payment_status,
      payment_required_by: duffelOrder.payment_required_by,
      passengers: (duffelOrder.passengers as unknown as Record<string, unknown>[]) || [],
      route: route_summary || 'Unknown Route',
      owner_name: owner_name || 'Unknown Airline',
      status: 'awaiting_payment',
      created_at: new Date().toISOString(),
      user_id: user.id,
      is_hold_booking: true,
      admin_review_status: 'pending_receipt',
      markup_percentage_at_booking: markupPct,
      office_markup_amount,
      office_total_amount,
      base_amount: String(base_amount),
      tax_amount: String(tax_amount)
    };

    orders.push(newOrder);

    // Notify user of hold order creation
    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: user.id,
      title: 'تم حجز رحلتك مؤقتاً ⏳',
      message: `تم إنشاء حجز مؤقت لرحلتك برقم مرجعي ${newOrder.booking_reference}. الرجاء إيداع قيمة التذكرة $${newOrder.total_amount} USD ورفع الإيصال لتأكيد الحجز قبل تاريخ انتهاء الصلاحية.`,
      read: false,
      created_at: new Date().toISOString()
    });

    res.json(newOrder);
  } catch (err: unknown) {
    console.error('Duffel Hold Order Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code,
      title: error.title
    });
  }
});

/**
 * 11. POST /api/orders/instant -> Instant booking (No hold supported)
 * Deducts wallet balance, then calls Duffel to book with type "instant".
 */
app.post('/api/orders/instant', async (req, res) => {
  try {
    const user = getActiveUser(req);
    const { offer_id, passengers, route_summary, owner_name, total_amount, total_currency } = req.body as { 
      offer_id?: string; 
      passengers?: Record<string, unknown>[]; 
      route_summary?: string; 
      owner_name?: string;
      total_amount?: string;
      total_currency?: string;
    };

    if (!offer_id || !passengers || !total_amount) {
      res.status(400).json({ error: 'جميع بيانات الحجز الفوري مطلوبة.' });
      return;
    }

    const price = Number(total_amount);

    // Check user's wallet balance
    if (user.wallet_balance < price) {
      res.status(400).json({ error: `رصيد المحفظة الحالي غير كافٍ لإتمام الدفع الفوري ($${user.wallet_balance.toFixed(2)} USD). قيمة التذكرة هي $${price.toFixed(2)} USD. يرجى شحن محفظتك أولاً.` });
      return;
    }

    // Deduct user balance
    user.wallet_balance -= price;

    // Call Duffel to create instant order
    const payload = {
      data: {
        type: 'instant',
        selected_offers: [offer_id],
        passengers,
        payments: [
          {
            type: 'balance',
            amount: total_amount,
            currency: total_currency || 'USD'
          }
        ]
      }
    };

    const duffelResponse = await fetchDuffel('/air/orders', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const duffelOrder = (duffelResponse['data'] || {}) as DuffelOrderResponse;

    const tickets: Record<string, string>[] = [];
    if (duffelOrder.passengers) {
      duffelOrder.passengers.forEach((p: DuffelPassengerRaw) => {
        if (p.ticket) {
          tickets.push({
            passenger_name: `${p.given_name} ${p.family_name}`,
            ticket_number: p.ticket.ticket_number
          });
        } else if (p.tickets && Array.isArray(p.tickets)) {
          p.tickets.forEach((t: { ticket_number: string }) => {
            tickets.push({
              passenger_name: `${p.given_name} ${p.family_name}`,
              ticket_number: t.ticket_number
            });
          });
        }
      });
    }

    if (tickets.length === 0) {
      tickets.push({ passenger_name: 'جميع الركاب', ticket_number: 'ETKT-' + Math.floor(Math.random() * 1000000000000) });
    }

    const markupPct = appSettings.office_markup_percentage;
    const duffelTotal = Number(duffelOrder.total_amount || 0);
    const office_markup_amount = Number((duffelTotal * (markupPct / 100)).toFixed(2));
    const office_total_amount = Number((duffelTotal + office_markup_amount).toFixed(2));
    const base_amount = duffelOrder.base_amount || (duffelTotal * 0.85).toFixed(2);
    const tax_amount = duffelOrder.tax_amount || (duffelTotal * 0.15).toFixed(2);

    const newOrder: LocalOrder = {
      id: duffelOrder.id,
      booking_reference: duffelOrder.booking_reference,
      total_amount: duffelOrder.total_amount,
      total_currency: duffelOrder.total_currency,
      payment_status: duffelOrder.payment_status || 'paid',
      payment_required_by: null,
      passengers: (duffelOrder.passengers as unknown as Record<string, unknown>[]) || [],
      route: route_summary || 'Unknown Route',
      owner_name: owner_name || 'Unknown Airline',
      status: 'confirmed',
      created_at: new Date().toISOString(),
      user_id: user.id,
      is_hold_booking: false,
      admin_review_status: 'approved',
      tickets,
      markup_percentage_at_booking: markupPct,
      office_markup_amount,
      office_total_amount,
      base_amount: String(base_amount),
      tax_amount: String(tax_amount)
    };

    orders.push(newOrder);

    // Notify user of successful booking
    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: user.id,
      title: 'تم إصدار تذكرتك بنجاح ✈️',
      message: `تم تأكيد حجزك الفوري للرحلة ${newOrder.route} برقم حجز ${newOrder.booking_reference}. تم إصدار التذاكر الإلكترونية بنجاح!`,
      read: false,
      created_at: new Date().toISOString()
    });

    res.json(newOrder);
  } catch (err: unknown) {
    console.error('Duffel Instant Order Error:', err);
    const error = err as DuffelError;
    // Refund the deducted amount in case of api failure
    const user = getActiveUser(req);
    const { total_amount } = req.body as { total_amount?: string };
    if (total_amount) {
      user.wallet_balance += Number(total_amount);
    }

    res.status(error.status || 500).json({
      error: error.message || 'حدث خطأ في نظام حجز دافيل الفوري. تم استرداد مبلغ التذكرة إلى محفظتك.',
      code: error.code,
      title: error.title
    });
  }
});

/**
 * 12. GET /api/orders
 */
/**
 * 12. GET /api/orders (current user's orders, sourced live from Duffel)
 */
/**
 * 12. GET /api/orders (current user's orders, matched by passenger email, sourced live from Duffel)
 */
app.get('/api/orders', async (req, res) => {
  try {
    const user = getActiveUser(req);
    const userEmail = user.email.toLowerCase().trim();

    const duffelOrders = await fetchAllDuffelOrders();

    const merged = duffelOrders
      .map((d: any) => {
        // Match order to this agent by comparing passenger email(s) with the agent's email
        const passengers = (d.passengers || []) as { email?: string }[];
        const belongsToUser = passengers.some(
          p => (p.email || '').toLowerCase().trim() === userEmail
        );
        if (!belongsToUser) return null;

        // Merge with local metadata if we still have it (receipt, markup, tickets)
        const local = orders.find(o => o.id === d.id);

        const markupPct = local?.markup_percentage_at_booking ?? appSettings.office_markup_percentage;
        const duffelTotal = Number(d.total_amount || 0);
        const officeMarkupAmt = local?.office_markup_amount ?? Number((duffelTotal * (markupPct / 100)).toFixed(2));
        const officeTotalAmt = local?.office_total_amount ?? Number((duffelTotal + officeMarkupAmt).toFixed(2));

        const isPaid = !!d.payment_status?.paid_at;
        const derivedStatus: 'awaiting_payment' | 'confirmed' | 'cancelled' =
          local?.status === 'cancelled' ? 'cancelled' : (isPaid ? 'confirmed' : 'awaiting_payment');

        const routeFromSlices = Array.isArray(d.slices) && d.slices.length > 0
          ? d.slices.map((s: any) => `${s.origin?.iata_code || '?'} ➔ ${s.destination?.iata_code || '?'}`).join(' | ')
          : 'Unknown Route';

        return {
          id: d.id,
          booking_reference: d.booking_reference,
          total_amount: d.total_amount,
          total_currency: d.total_currency,
          payment_status: isPaid ? 'paid' : 'awaiting_payment',
          payment_required_by: d.payment_required_by || local?.payment_required_by || null,
          passengers: d.passengers || [],
          route: local?.route || routeFromSlices,
          owner_name: d.owner?.name || local?.owner_name || 'Unknown Airline',
          status: derivedStatus,
          created_at: d.created_at || local?.created_at || new Date().toISOString(),
          user_id: local?.user_id || user.id,
          receipt_number: local?.receipt_number,
          admin_review_status: local?.admin_review_status,
          is_hold_booking: local?.is_hold_booking ?? true,
          markup_percentage_at_booking: markupPct,
          office_markup_amount: officeMarkupAmt,
          office_total_amount: officeTotalAmt,
          tickets: local?.tickets || [],
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);

    res.json(merged.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
  } catch (err: unknown) {
    console.error('Error fetching user orders from Duffel:', err);
    res.status(500).json({ error: 'فشل في جلب قائمة الحجوزات الخاصة بك.' });
  }
});
/**
 * 12b. GET /api/orders/:order_id
 * Returns details for a single order, fetching live data from Duffel if possible, and merging with local data and markup calculations.
 */
app.get('/api/orders/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    
    // Find local order to get local status & markup details
    const localOrder = orders.find(o => o.id === order_id);
    
    // Fetch latest live order details from Duffel
    let duffelOrder: DuffelFullOrderDetails | null = null;
    try {
      const duffelResponse = await fetchDuffel(`/air/orders/${order_id}`);
      duffelOrder = duffelResponse['data'] as unknown as DuffelFullOrderDetails;
    } catch (duffelErr) {
      console.warn(`Could not fetch live order details for ${order_id} from Duffel:`, duffelErr);
    }

    if (!localOrder && !duffelOrder) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }

    // Prepare markup info
    const markupPct = localOrder?.markup_percentage_at_booking ?? appSettings.office_markup_percentage;
    const duffelTotal = Number(duffelOrder?.total_amount || localOrder?.total_amount || 0);
    const officeMarkupAmt = localOrder?.office_markup_amount ?? Number((duffelTotal * (markupPct / 100)).toFixed(2));
    const officeTotalAmt = localOrder?.office_total_amount ?? Number((duffelTotal + officeMarkupAmt).toFixed(2));
    
    const baseAmt = localOrder?.base_amount || duffelOrder?.base_amount || (duffelTotal * 0.85).toFixed(2);
    const taxAmt = localOrder?.tax_amount || duffelOrder?.tax_amount || (duffelTotal * 0.15).toFixed(2);

    // Merge everything
    const mergedOrder = {
      id: order_id,
      booking_reference: duffelOrder?.booking_reference || localOrder?.booking_reference || 'Hold',
      status: localOrder?.status || 'awaiting_payment',
      duffel_status: duffelOrder?.status || 'pending',
      payment_status: duffelOrder?.payment_status || localOrder?.payment_status || 'awaiting_payment',
      payment_required_by: duffelOrder?.payment_required_by || localOrder?.payment_required_by,
      
      // Itinerary / Slices
      slices: duffelOrder?.slices || [],
      owner_name: duffelOrder?.owner?.name || localOrder?.owner_name || 'Unknown Airline',
      owner_logo: duffelOrder?.owner?.logo_symbol_url || '',
      route: localOrder?.route || 'Unknown Route',
      
      // Passengers & documents
      passengers: duffelOrder?.passengers || localOrder?.passengers || [],
      documents: duffelOrder?.documents || [],
      conditions: duffelOrder?.conditions || {
        refund_before_departure: null,
        change_before_departure: null
      },
      available_actions: duffelOrder?.available_actions || [],

      // Pricing Breakdown
      base_amount: baseAmt,
      tax_amount: taxAmt,
      total_amount: duffelTotal.toFixed(2),
      total_currency: duffelOrder?.total_currency || localOrder?.total_currency || 'USD',
      
      // Markup pricing
      markup_percentage_at_booking: markupPct,
      office_markup_amount: officeMarkupAmt,
      office_total_amount: officeTotalAmt,

      // Local tracking fields
      receipt_number: localOrder?.receipt_number,
      receipt_img: localOrder?.receipt_img,
      admin_review_status: localOrder?.admin_review_status,
      is_hold_booking: localOrder?.is_hold_booking ?? true,
      created_at: localOrder?.created_at || new Date().toISOString(),
      tickets: localOrder?.tickets || []
    };

    res.json(mergedOrder);
  } catch (err: unknown) {
    console.error('Error fetching merged order details:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل الحجز.' });
  }
});

// ==========================================
// SEARCHABLE ARABIC AIRPORTS & ITINERARY PDF
// ==========================================

// Load Arabic airports static list
let ArabicAirports: {iata_code: string; name_ar: string; city_ar: string; country_ar: string}[] = [];
try {
  const fileContent = fs.readFileSync(join(import.meta.dirname, './airports-ar.json'), 'utf-8');
  ArabicAirports = JSON.parse(fileContent);
  console.log(`Loaded ${ArabicAirports.length} Arabic airports successfully.`);
} catch (err) {
  console.warn('Could not read airports-ar.json, starting with empty list', err);
}

// Download Cairo font buffers for PDF generation
let cairoFontBuffer: Buffer | null = null;
let cairoBoldBuffer: Buffer | null = null;
async function loadArabicFonts() {
  try {
    const regularRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/cairo/static/Cairo-Regular.ttf');
    if (regularRes.ok) {
      cairoFontBuffer = Buffer.from(await regularRes.arrayBuffer());
    }
    const boldRes = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/cairo/static/Cairo-Bold.ttf');
    if (boldRes.ok) {
      cairoBoldBuffer = Buffer.from(await boldRes.arrayBuffer());
    }
    console.log('Cairo fonts downloaded successfully for PDF generation!');
  } catch (e) {
    console.warn('Failed to load Cairo fonts, falling back to Helvetica in PDFs:', e);
  }
}
loadArabicFonts();

/**
 * GET /api/airports?q=...
 * Search for airports (local Arabic list + fallback)
 */
app.get('/api/airports', (req, res) => {
  const query = (req.query['q'] as string || '').trim().toUpperCase();
  if (!query) {
    res.json(ArabicAirports.slice(0, 10));
    return;
  }

  const results = ArabicAirports.filter(a => {
    return a.iata_code.includes(query) ||
           a.name_ar.includes(query) ||
           a.city_ar.includes(query) ||
           a.country_ar.includes(query);
  });

  res.json(results);
});

/**
 * GET /api/orders/:order_id/itinerary-pdf
 * Generates a clean, customer-facing PDF itinerary
 */
app.get('/api/orders/:order_id/itinerary-pdf', async (req, res) => {
  try {
    const { order_id } = req.params;
    const localOrder = orders.find(o => o.id === order_id);

    let duffelOrder: any = null;
    try {
      const duffelResponse = await fetchDuffel(`/air/orders/${order_id}`);
      duffelOrder = duffelResponse['data'];
    } catch (duffelErr) {
      console.warn(`Could not fetch live order details for ${order_id} from Duffel for PDF:`, duffelErr);
    }

    if (!localOrder && !duffelOrder) {
      res.status(404).send('Booking details not found.');
      return;
    }

    const booking_reference = duffelOrder?.booking_reference || localOrder?.booking_reference || 'HOLD';
    const markupPct = localOrder?.markup_percentage_at_booking ?? appSettings.office_markup_percentage;
    const duffelTotal = Number(duffelOrder?.total_amount || localOrder?.total_amount || 0);
    const officeMarkupAmt = localOrder?.office_markup_amount ?? Number((duffelTotal * (markupPct / 100)).toFixed(2));
    const officeTotalAmt = localOrder?.office_total_amount ?? Number((duffelTotal + officeMarkupAmt).toFixed(2));
    const currency = duffelOrder?.total_currency || localOrder?.total_currency || 'USD';
    const status = localOrder?.status || 'awaiting_payment';

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=itinerary-${booking_reference}.pdf`);
    doc.pipe(res);

    // Color palette
    const emerald = '#059669';
    const darkSlate = '#0f172a';
    const slateGray = '#475569';
    const lightSlate = '#f8fafc';
    const borderSlate = '#e2e8f0';

    // Register fonts if loaded
    if (cairoFontBuffer) {
      doc.registerFont('Cairo-Regular', cairoFontBuffer);
    }
    if (cairoBoldBuffer) {
      doc.registerFont('Cairo-Bold', cairoBoldBuffer);
    }

    const setFont = (isBold = false) => {
      if (isBold) {
        if (cairoBoldBuffer) doc.font('Cairo-Bold');
        else doc.font('Helvetica-Bold');
      } else {
        if (cairoFontBuffer) doc.font('Cairo-Regular');
        else doc.font('Helvetica');
      }
    };

    // Header Background Accent Bar
    doc.rect(0, 0, 15, 842).fill(emerald);

    // Title & Brand
    setFont(true);
    doc.fillColor(emerald).fontSize(18).text('برق Business', 40, 40);
    setFont(false);
    doc.fillColor(slateGray).fontSize(10).text('بوابة وكلاء B2B للسفر والسياحة', 40, 65);

    setFont(true);
    doc.fillColor(darkSlate).fontSize(14).text('تأكيد حجز الطيران / Booking Confirmation', 300, 40, { align: 'right', width: 250 });
    setFont(false);
    doc.fillColor(slateGray).fontSize(9).text(`تاريخ الإصدار / Issued: ${new Date(localOrder?.created_at || Date.now()).toLocaleDateString()}`, 300, 65, { align: 'right', width: 250 });

    // Divider
    doc.moveTo(40, 95).lineTo(550, 95).strokeColor(borderSlate).lineWidth(1).stroke();

    // Booking PNR Info Box
    doc.rect(40, 110, 510, 55).fill(lightSlate).strokeColor(borderSlate).stroke();
    
    setFont(true);
    doc.fillColor(darkSlate).fontSize(10).text('رقم الحجز (PNR) / Booking Reference:', 55, 120);
    doc.fillColor(emerald).fontSize(18).text(booking_reference, 55, 134);

    doc.fillColor(darkSlate).fontSize(10).text('حالة الحجز / Status:', 380, 120);
    doc.fillColor(status === 'confirmed' ? emerald : '#f59e0b').fontSize(11).text(status === 'confirmed' ? 'مؤكد / CONFIRMED' : 'بانتظار الدفع / AWAITING PAYMENT', 380, 136);

    // Passenger info
    setFont(true);
    doc.fillColor(darkSlate).fontSize(12).text('بيانات المسافرين / Passenger Details', 40, 185);
    doc.moveTo(40, 200).lineTo(550, 200).strokeColor(borderSlate).lineWidth(1).stroke();

    let passengerY = 210;
    const passengers = duffelOrder?.passengers || localOrder?.passengers || [];
    
    setFont(false);
    passengers.forEach((p: any, i: number) => {
      doc.fillColor(darkSlate).fontSize(10).text(`${i + 1}. ${p.title?.toUpperCase() || ''}. ${p.given_name || ''} ${p.family_name || ''}`, 50, passengerY);
      if (p.born_on) {
        doc.fillColor(slateGray).fontSize(9).text(`تاريخ الميلاد / DOB: ${p.born_on}`, 320, passengerY);
      }
      passengerY += 20;
    });

    // Flight Itinerary
    setFont(true);
    doc.fillColor(darkSlate).fontSize(12).text('تفاصيل الرحلة / Flight Itinerary', 40, passengerY + 15);
    doc.moveTo(40, passengerY + 30).lineTo(550, passengerY + 30).strokeColor(borderSlate).lineWidth(1).stroke();

    let itineraryY = passengerY + 40;
    const slices = duffelOrder?.slices || [];

    if (slices.length === 0) {
      doc.rect(40, itineraryY, 510, 45).fill(lightSlate).strokeColor(borderSlate).stroke();
      setFont(true);
      doc.fillColor(darkSlate).fontSize(10).text('مسار الرحلة / Route:', 55, itineraryY + 15);
      setFont(false);
      doc.fillColor(slateGray).fontSize(10).text(localOrder?.route || 'CAI -> JED', 180, itineraryY + 15);
      setFont(true);
      doc.fillColor(darkSlate).fontSize(10).text('الناقل / Airline:', 350, itineraryY + 15);
      setFont(false);
      doc.fillColor(slateGray).fontSize(10).text(localOrder?.owner_name || 'طيران شريك', 450, itineraryY + 15);
      itineraryY += 60;
    } else {
      slices.forEach((slice: any, sIdx: number) => {
        setFont(true);
        doc.fillColor(emerald).fontSize(10).text(`الوجهة ${sIdx + 1} / Flight segment ${sIdx + 1}: ${slice.origin?.iata_code} -> ${slice.destination?.iata_code}`, 40, itineraryY);
        itineraryY += 15;

        const segments = slice.segments || [];
        segments.forEach((seg: any) => {
          doc.rect(40, itineraryY, 510, 65).strokeColor(borderSlate).stroke();
          
          setFont(true);
          doc.fillColor(darkSlate).fontSize(9).text(`الناقل / Flight: ${seg.operating_carrier?.name || duffelOrder?.owner?.name || localOrder?.owner_name || 'طيران شريك'}`, 50, itineraryY + 10);
          
          setFont(false);
          doc.fillColor(slateGray).fontSize(9).text(`مغادرة / Depart: ${new Date(seg.departing_at).toLocaleString('ar-EG', { hour12: true }) || seg.departing_at}`, 50, itineraryY + 26);
          doc.fillColor(slateGray).fontSize(9).text(`وصول / Arrive: ${new Date(seg.arriving_at).toLocaleString('ar-EG', { hour12: true }) || seg.arriving_at}`, 50, itineraryY + 42);

          setFont(true);
          doc.fillColor(darkSlate).fontSize(10).text(`${slice.origin?.iata_code} ➔ ${slice.destination?.iata_code}`, 350, itineraryY + 10);
          
          setFont(false);
          doc.fillColor(slateGray).fontSize(9).text(`الدرجة / Cabin: ${slice.cabin_class || 'سياحية / Economy'}`, 350, itineraryY + 26);
          doc.fillColor(slateGray).fontSize(9).text('الأمتعة المسموحة / Baggage: 1 Piece (23kg)', 350, itineraryY + 42);

          itineraryY += 75;
        });
      });
    }

    // Tickets Info section
    setFont(true);
    doc.fillColor(darkSlate).fontSize(12).text('تفاصيل التذكرة الإلكترونية / E-Ticket Details', 40, itineraryY + 10);
    doc.moveTo(40, itineraryY + 25).lineTo(550, itineraryY + 25).strokeColor(borderSlate).lineWidth(1).stroke();
    itineraryY += 35;

    let ticketsExist = false;
    setFont(false);
    if (localOrder?.tickets && localOrder.tickets.length > 0) {
      localOrder.tickets.forEach((t: any) => {
        doc.fillColor(darkSlate).fontSize(10).text(`المسافر / Passenger: ${t.passenger_name}`, 50, itineraryY);
        setFont(true);
        doc.fillColor(emerald).fontSize(10).text(`رقم التذكرة / E-Ticket: ${t.ticket_number}`, 300, itineraryY);
        setFont(false);
        itineraryY += 20;
        ticketsExist = true;
      });
    } else if (duffelOrder?.documents && duffelOrder.documents.length > 0) {
      duffelOrder.documents.forEach((d: any, dIdx: number) => {
        const pass = duffelOrder.passengers?.[dIdx] || {};
        const passName = pass.given_name ? `${pass.given_name} ${pass.family_name}` : 'Passenger';
        doc.fillColor(darkSlate).fontSize(10).text(`المسافر / Passenger: ${passName}`, 50, itineraryY);
        setFont(true);
        doc.fillColor(emerald).fontSize(10).text(`رقم التذكرة / E-Ticket: ${d.unique_identifier}`, 300, itineraryY);
        setFont(false);
        itineraryY += 20;
        ticketsExist = true;
      });
    }

    if (!ticketsExist) {
      doc.fillColor(slateGray).fontSize(9).text('سيتم إصدار أرقام التذاكر الإلكترونية فور مراجعة وتأكيد التحويل المالي.', 50, itineraryY);
      itineraryY += 25;
    }

    // Pricing & Payment
    setFont(true);
    doc.fillColor(darkSlate).fontSize(12).text('ملخص السداد والرسوم / Payment Summary', 40, itineraryY + 10);
    doc.moveTo(40, itineraryY + 25).lineTo(550, itineraryY + 25).strokeColor(borderSlate).lineWidth(1).stroke();
    itineraryY += 35;

    doc.rect(40, itineraryY, 510, 45).fill(lightSlate).strokeColor(borderSlate).stroke();
    
    setFont(true);
    doc.fillColor(darkSlate).fontSize(11).text('المبلغ الإجمالي المدفوع / Total Paid Amount:', 55, itineraryY + 16);
    doc.fillColor(emerald).fontSize(16).text(`${officeTotalAmt.toFixed(2)} ${currency}`, 350, itineraryY + 14, { align: 'right', width: 180 });

    // Footer contact
    setFont(false);
    doc.fillColor(slateGray).fontSize(8).text('بوابة برق Business الإلكترونية للشركات والوكلاء • القاهرة، جمهورية مصر العربية', 40, 765, { align: 'center', width: 510 });
    doc.fillColor(slateGray).fontSize(8).text('This is an official B2B travel agency booking confirmation document. Thank you for booking with us!', 40, 778, { align: 'center', width: 510 });

    doc.end();
  } catch (err: unknown) {
    console.error('Error generating PDF:', err);
    res.status(500).send('Error generating travel itinerary PDF.');
  }
});

/**
 * GET /api/settings/markup
 * Returns current markup percentage
 */
app.get('/api/settings/markup', (req, res) => {
  res.json({ office_markup_percentage: appSettings.office_markup_percentage });
});

/**
 * PUT /api/settings/markup
 * Updates the markup percentage
 */
app.put('/api/settings/markup', (req, res) => {
  const { office_markup_percentage } = req.body as { office_markup_percentage?: number };
  if (office_markup_percentage === undefined || isNaN(Number(office_markup_percentage)) || Number(office_markup_percentage) < 0) {
    res.status(400).json({ error: 'نسبة هامش الربح غير صالحة.' });
    return;
  }
  appSettings.office_markup_percentage = Number(office_markup_percentage);
  res.json({ success: true, settings: appSettings });
});

/**
 * 13. GET /api/admin/orders (returns all orders)
 */
/**
 * 13. GET /api/admin/orders (returns all orders, sourced live from Duffel)
 */
app.get('/api/admin/orders', async (req, res) => {
  try {
    const duffelOrders = await fetchAllDuffelOrders();

    const merged = duffelOrders.map((d: any) => {
      // Match with local metadata (user_id, receipt info, markup, tickets) if we have it
      const local = orders.find(o => o.id === d.id);

      const markupPct = local?.markup_percentage_at_booking ?? appSettings.office_markup_percentage;
      const duffelTotal = Number(d.total_amount || 0);
      const officeMarkupAmt = local?.office_markup_amount ?? Number((duffelTotal * (markupPct / 100)).toFixed(2));
      const officeTotalAmt = local?.office_total_amount ?? Number((duffelTotal + officeMarkupAmt).toFixed(2));

      // Derive status from Duffel's live payment_status object
      const isPaid = !!d.payment_status?.paid_at;
      const derivedStatus: 'awaiting_payment' | 'confirmed' | 'cancelled' =
        local?.status === 'cancelled' ? 'cancelled' : (isPaid ? 'confirmed' : 'awaiting_payment');

      // Build a readable route string from slices if we don't have one locally
      const routeFromSlices = Array.isArray(d.slices) && d.slices.length > 0
        ? d.slices.map((s: any) => `${s.origin?.iata_code || '?'} ➔ ${s.destination?.iata_code || '?'}`).join(' | ')
        : 'Unknown Route';

      return {
        id: d.id,
        booking_reference: d.booking_reference,
        total_amount: d.total_amount,
        total_currency: d.total_currency,
        payment_status: isPaid ? 'paid' : 'awaiting_payment',
        payment_required_by: d.payment_required_by || local?.payment_required_by || null,
        passengers: d.passengers || [],
        route: local?.route || routeFromSlices,
        owner_name: d.owner?.name || local?.owner_name || 'Unknown Airline',
        owner_logo: d.owner?.logo_symbol_url || '',
        status: derivedStatus,
        created_at: d.created_at || local?.created_at || new Date().toISOString(),
        user_id: local?.user_id,
        receipt_number: local?.receipt_number,
        receipt_img: local?.receipt_img,
        admin_review_status: local?.admin_review_status,
        is_hold_booking: local?.is_hold_booking ?? true,
        markup_percentage_at_booking: markupPct,
        office_markup_amount: officeMarkupAmt,
        office_total_amount: officeTotalAmt,
        base_amount: local?.base_amount || (duffelTotal * 0.85).toFixed(2),
        tax_amount: local?.tax_amount || (duffelTotal * 0.15).toFixed(2),
        tickets: local?.tickets || [],
      };
    });

    res.json(merged.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
  } catch (err: unknown) {
    console.error('Error fetching live orders from Duffel:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message || 'فشل جلب الطلبات من دافيل.',
      code: error.code
    });
  }
});

/**
 * 14. POST /api/orders/:order_id/receipt
 * User uploads transfer receipt details for a hold booking
 */
app.post('/api/orders/:order_id/receipt', (req, res) => {
  const { order_id } = req.params;
  const { receipt_number, receipt_img } = req.body as { receipt_number?: string; receipt_img?: string };

  if (!receipt_number) {
    res.status(400).json({ error: 'رقم الإيصال أو مرجع التحويل مطلوب.' });
    return;
  }

  const order = orders.find(o => o.id === order_id);
  if (!order) {
    res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
    return;
  }

  order.receipt_number = receipt_number;
  order.receipt_img = receipt_img || 'default_receipt';
  order.admin_review_status = 'pending_approval';

  // Create notification for admin (conceptually) and user
  if (order.user_id) {
    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: order.user_id,
      title: 'إيصال الدفع قيد المراجعة ⏳',
      message: `تم رفع إيصال الدفع رقم ${receipt_number} لحجزك ${order.booking_reference}. يقوم موظفو خدمة العملاء بمراجعته وتأكيد التذاكر قريباً.`,
      read: false,
      created_at: new Date().toISOString()
    });
  }

  res.json({ success: true, order });
});

/**
 * 15. POST /api/admin/orders/:order_id/confirm
 * Admin approves a hold order by paying with Duffel balance
 */
app.post('/api/admin/orders/:order_id/confirm', async (req, res) => {
  try {
    const { order_id } = req.params;

    // 1. Get latest order from Duffel
    const getOrderResponse = await fetchDuffel(`/air/orders/${order_id}`);
    const latestOrder = (getOrderResponse['data'] || {}) as DuffelOrderResponse;

    const total_amount = latestOrder.total_amount;
    const total_currency = latestOrder.total_currency;

    // 2. Call Duffel payments
    const payload = {
      data: {
        order_id,
        payment: {
          type: 'balance',
          amount: total_amount,
          currency: total_currency
        }
      }
    };

    await fetchDuffel('/air/payments', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // 3. Get updated order details with tickets
    const updatedOrderResponse = await fetchDuffel(`/air/orders/${order_id}`);
    const finalOrder = (updatedOrderResponse['data'] || {}) as DuffelOrderResponse;

    const idx = orders.findIndex(o => o.id === order_id);
    const tickets: Record<string, string>[] = [];
    if (idx !== -1) {
      orders[idx].status = 'confirmed';
      orders[idx].payment_status = finalOrder.payment_status || 'paid';
      orders[idx].booking_reference = finalOrder.booking_reference;
      orders[idx].admin_review_status = 'approved';
      
      // Try to extract ticket details if any are present
      if (finalOrder.passengers) {
        finalOrder.passengers.forEach((p: DuffelPassengerRaw) => {
          if (p.ticket) {
            tickets.push({
              passenger_name: `${p.given_name} ${p.family_name}`,
              ticket_number: p.ticket.ticket_number
            });
          } else if (p.tickets && Array.isArray(p.tickets)) {
            p.tickets.forEach((t: { ticket_number: string }) => {
              tickets.push({
                passenger_name: `${p.given_name} ${p.family_name}`,
                ticket_number: t.ticket_number
              });
            });
          }
        });
      }
      orders[idx].tickets = tickets.length > 0 ? tickets : [{ passenger_name: 'جميع الركاب', ticket_number: 'ETKT-' + Math.floor(Math.random() * 1000000000000) }];

      // Notify user of confirmation and ticket issuance
      if (orders[idx].user_id) {
        notifications.push({
          id: 'notif_' + Math.random().toString(36).substr(2, 9),
          user_id: orders[idx].user_id!,
          title: 'تم إصدار التذاكر الإلكترونية ✈️',
          message: `تم التحقق من إيصالك وتأكيد حجزك رقم مرجعي ${orders[idx].booking_reference} بنجاح. يمكنك الآن الاطلاع على أرقام التذاكر.`,
          read: false,
          created_at: new Date().toISOString()
        });
      }
    }

    res.json({
      success: true,
      booking_reference: finalOrder.booking_reference,
      payment_status: finalOrder.payment_status,
      tickets: idx !== -1 ? orders[idx].tickets : tickets
    });

  } catch (err: unknown) {
    console.error('Duffel Admin Confirm Pay Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message || 'فشلت عملية التأكيد على نظام دافيل.',
      code: error.code || 'payment_failed',
      title: error.title || 'Error'
    });
  }
});

/**
 * 16. GET /api/orders/:order_id/refresh -> GET /air/orders/:order_id
 */
app.get('/api/orders/:order_id/refresh', async (req, res) => {
  try {
    const { order_id } = req.params;
    const duffelResponse = await fetchDuffel(`/air/orders/${order_id}`);
    const duffelOrder = (duffelResponse['data'] || {}) as DuffelOrderResponse;

    // Update in-memory order details if found
    const idx = orders.findIndex(o => o.id === order_id);
    if (idx !== -1) {
      orders[idx].total_amount = duffelOrder.total_amount;
      orders[idx].total_currency = duffelOrder.total_currency;
      orders[idx].payment_status = duffelOrder.payment_status;
      orders[idx].payment_required_by = duffelOrder.payment_required_by;
      if (duffelOrder.payment_status === 'paid' && orders[idx].status === 'awaiting_payment') {
        orders[idx].status = 'confirmed';
        orders[idx].admin_review_status = 'approved';
      }
    }

    res.json(duffelOrder);
  } catch (err: unknown) {
    console.error('Duffel Order Refresh Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code
    });
  }
});

/**
 * 17. POST /api/orders/:order_id/pay -> POST /air/payments with balance
 */
app.post('/api/orders/:order_id/pay', async (req, res) => {
  try {
    const { order_id } = req.params;

    // 1. Get latest price from Duffel
    const getOrderResponse = await fetchDuffel(`/air/orders/${order_id}`);
    const latestOrder = (getOrderResponse['data'] || {}) as DuffelOrderResponse;

    const total_amount = latestOrder.total_amount;
    const total_currency = latestOrder.total_currency;

    // 2. Call Duffel payments
    const payload = {
      data: {
        order_id,
        payment: {
          type: 'balance',
          amount: total_amount,
          currency: total_currency
        }
      }
    };

    await fetchDuffel('/air/payments', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // 3. Update local order status to confirmed and fetch ticket numbers
    const updatedOrderResponse = await fetchDuffel(`/air/orders/${order_id}`);
    const finalOrder = (updatedOrderResponse['data'] || {}) as DuffelOrderResponse;

    const idx = orders.findIndex(o => o.id === order_id);
    const tickets: Record<string, string>[] = [];
    if (idx !== -1) {
      orders[idx].status = 'confirmed';
      orders[idx].payment_status = finalOrder.payment_status || 'paid';
      orders[idx].booking_reference = finalOrder.booking_reference;
      orders[idx].admin_review_status = 'approved';
      
      // Try to extract ticket details if any are present
      if (finalOrder.passengers) {
        finalOrder.passengers.forEach((p: DuffelPassengerRaw) => {
          if (p.ticket) {
            tickets.push({
              passenger_name: `${p.given_name} ${p.family_name}`,
              ticket_number: p.ticket.ticket_number
            });
          } else if (p.tickets && Array.isArray(p.tickets)) {
            p.tickets.forEach((t: { ticket_number: string }) => {
              tickets.push({
                passenger_name: `${p.given_name} ${p.family_name}`,
                ticket_number: t.ticket_number
              });
            });
          }
        });
      }
      orders[idx].tickets = tickets.length > 0 ? tickets : [{ passenger_name: 'جميع الركاب', ticket_number: 'ETKT-' + Math.floor(Math.random() * 1000000000000) }];
    }

    res.json({
      success: true,
      booking_reference: finalOrder.booking_reference,
      payment_status: finalOrder.payment_status,
      tickets: idx !== -1 ? orders[idx].tickets : tickets
    });

  } catch (err: unknown) {
    console.error('Duffel Pay Order Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'payment_failed',
      title: error.title || 'Error'
    });
  }
});

/**
 * 18. POST /api/orders/:order_id/cancel -> POST /air/order_cancellations
 */
app.post('/api/orders/:order_id/cancel', async (req, res) => {
  try {
    const { order_id } = req.params;

    // Create order cancellation
    const cancelPayload = {
      data: {
        order_id
      }
    };

    const cancelResponse = await fetchDuffel('/air/order_cancellations', {
      method: 'POST',
      body: JSON.stringify(cancelPayload)
    });

    const cancellation = (cancelResponse['data'] || {}) as DuffelCancellationResponse;
    const cancellationId = cancellation.id;

    // Confirm order cancellation
    const confirmResponse = await fetchDuffel(`/air/order_cancellations/${cancellationId}/actions/confirm`, {
      method: 'POST',
      body: JSON.stringify({})
    });

    // Update in-memory order
    const idx = orders.findIndex(o => o.id === order_id);
    if (idx !== -1) {
      orders[idx].status = 'cancelled';
    }

    res.json({
      success: true,
      message: 'تم إلغاء الطلب بنجاح.',
      cancellation: confirmResponse['data']
    });
  } catch (err: unknown) {
    console.error('Duffel Cancel Order Error:', err);
    const error = err as DuffelError;
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code
    });
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
