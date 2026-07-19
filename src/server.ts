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

// Parse JSON request bodies with larger limits to support base64 images
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

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
  admin_review_status?: 'pending_receipt' | 'pending_approval' | 'approved' | 'rejected' | 'booking_in_progress' | 'completed';
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
  office_markup_percentage: 50 // Default 50% markup
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
    const { origin, destination, departure_date, return_date, cabin_class, passengers } = req.body as { origin?: string; destination?: string; departure_date?: string; return_date?: string; cabin_class?: string; passengers?: unknown[] };
    if (!origin || !destination || !departure_date) {
      res.status(400).json({ error: 'الأصل والوجهة وتاريخ المغادرة مطلوبة.' });
      return;
    }

    const slices = [
      {
        origin,
        destination,
        departure_date
      }
    ];

    if (return_date) {
      slices.push({
        origin: destination,
        destination: origin,
        departure_date: return_date
      });
    }

    const payload = {
      data: {
        slices,
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
    
    const markupPct = appSettings.office_markup_percentage;
    const offers = rawOffers.map((offer: DuffelOfferRaw) => {
      const duffelTotal = Number(offer.total_amount || 0);
      const markupAmount = Number((duffelTotal * (markupPct / 100)).toFixed(2));
      const officeTotalAmount = Number((duffelTotal + markupAmount).toFixed(2));
      return {
        id: offer.id,
        total_amount: String(officeTotalAmount),
        total_currency: offer.total_currency,
        owner: offer.owner || { name: 'Unknown Airline' },
        slices: offer.slices,
        requires_instant_payment: offer.payment_requirements?.requires_instant_payment ?? true,
        hold_supported: !offer.payment_requirements?.requires_instant_payment,
        base_amount: String(duffelTotal),
        markup_amount: String(markupAmount)
      };
    });

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
 * 10. POST /api/orders/hold -> Create local offline hold booking
 */
app.post('/api/orders/hold', (req, res) => {
  try {
    const user = getActiveUser(req);
    const { offer_id, passengers, route_summary, owner_name, receipt_number, receipt_img, total_amount, total_currency } = req.body as { 
      offer_id?: string; 
      passengers?: Record<string, unknown>[]; 
      route_summary?: string; 
      owner_name?: string;
      receipt_number?: string;
      receipt_img?: string;
      total_amount?: string;
      total_currency?: string;
    };
    if (!offer_id || !passengers || !total_amount) {
      res.status(400).json({ error: 'بيانات الحجز المؤقت غير كاملة.' });
      return;
    }

    const clientTotal = Number(total_amount);
    const markupPct = appSettings.office_markup_percentage;
    const base_amount = Number((clientTotal / (1 + markupPct / 100)).toFixed(2));
    const office_markup_amount = Number((clientTotal - base_amount).toFixed(2));
    const tax_amount = Number((base_amount * 0.15).toFixed(2));

    const orderId = 'brq_ord_' + Math.random().toString(36).substr(2, 9);
    const bookingRef = 'BRQ' + Math.floor(100000 + Math.random() * 900000);

    const hasReceipt = !!(receipt_number && receipt_number.trim());

    const newOrder: LocalOrder = {
      id: orderId,
      booking_reference: bookingRef,
      total_amount: String(clientTotal),
      total_currency: total_currency || 'USD',
      payment_status: hasReceipt ? 'paid' : 'unpaid',
      payment_required_by: new Date(Date.now() + 3600000 * 24).toISOString(), // 24 hours hold
      passengers: passengers || [],
      route: route_summary || 'Unknown Route',
      owner_name: owner_name || 'طيران شريك',
      status: 'awaiting_payment',
      created_at: new Date().toISOString(),
      user_id: user.id,
      is_hold_booking: true,
      receipt_number: receipt_number || undefined,
      receipt_img: receipt_img || undefined,
      admin_review_status: hasReceipt ? 'pending_approval' : 'pending_receipt',
      markup_percentage_at_booking: markupPct,
      office_markup_amount,
      office_total_amount: clientTotal,
      base_amount: String(base_amount),
      tax_amount: String(tax_amount),
      tickets: []
    };

    orders.push(newOrder);

    // Notify user
    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: user.id,
      title: hasReceipt ? 'تم تقديم إيصال سداد حجزك المؤقت ⏳' : 'تم حجز رحلتك مؤقتاً ⏳',
      message: hasReceipt 
        ? `تم إنشاء حجز مؤقت لرحلتك برقم مرجعي ${bookingRef} وتلقي إيصال السداد رقم ${receipt_number}. يقوم موظفو الخدمة بمراجعته الآن لتأكيد الحجز وإصدار التذاكر.`
        : `تم إنشاء حجز مؤقت لرحلتك برقم مرجعي ${bookingRef}. يرجى تحويل مبلغ $${clientTotal.toFixed(2)} USD ورفع الإيصال لتأكيد الحجز قبل انتهاء المهلة.`,
      read: false,
      created_at: new Date().toISOString()
    });

    res.json(newOrder);
  } catch (err: unknown) {
    console.error('Error creating hold order:', err);
    res.status(500).json({ error: 'فشل إتمام الحجز المؤقت.' });
  }
});

/**
 * 11. POST /api/orders/instant -> Local instant booking from user's wallet
 */
app.post('/api/orders/instant', (req, res) => {
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

    const clientTotal = Number(total_amount);
    if (user.wallet_balance < clientTotal) {
      res.status(400).json({ error: `رصيد المحفظة الحالي غير كافٍ لإتمام الحجز ($${user.wallet_balance.toFixed(2)} USD). القيمة المطلوبة هي $${clientTotal.toFixed(2)} USD.` });
      return;
    }

    // Deduct user balance
    user.wallet_balance -= clientTotal;

    const markupPct = appSettings.office_markup_percentage;
    const base_amount = Number((clientTotal / (1 + markupPct / 100)).toFixed(2));
    const office_markup_amount = Number((clientTotal - base_amount).toFixed(2));
    const tax_amount = Number((base_amount * 0.15).toFixed(2));

    const orderId = 'brq_ord_' + Math.random().toString(36).substr(2, 9);
    const bookingRef = 'BRQ' + Math.floor(100000 + Math.random() * 900000);

    const newOrder: LocalOrder = {
      id: orderId,
      booking_reference: bookingRef,
      total_amount: String(clientTotal),
      total_currency: total_currency || 'USD',
      payment_status: 'paid',
      payment_required_by: null,
      passengers: passengers || [],
      route: route_summary || 'Unknown Route',
      owner_name: owner_name || 'طيران شريك',
      status: 'awaiting_payment',
      created_at: new Date().toISOString(),
      user_id: user.id,
      is_hold_booking: false,
      admin_review_status: 'pending_approval', // Awaiting admin ticket issuance
      markup_percentage_at_booking: markupPct,
      office_markup_amount,
      office_total_amount: clientTotal,
      base_amount: String(base_amount),
      tax_amount: String(tax_amount),
      tickets: []
    };

    orders.push(newOrder);

    notifications.push({
      id: 'notif_' + Math.random().toString(36).substr(2, 9),
      user_id: user.id,
      title: 'تم خصم قيمة الحجز المباشر وجاري إصداره ⏳',
      message: `تم دفع قيمة حجزك رقم ${bookingRef} بقيمة $${clientTotal.toFixed(2)} USD من محفظتك بنجاح. جاري مراجعة وإصدار التذاكر الإلكترونية من قبل خدمة العملاء قريباً.`,
      read: false,
      created_at: new Date().toISOString()
    });

    res.json(newOrder);
  } catch (err: unknown) {
    console.error('Error in instant order:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء الحجز الفوري.' });
  }
});

/**
 * 12. GET /api/orders (Current user's local orders)
 */
app.get('/api/orders', (req, res) => {
  try {
    const user = getActiveUser(req);
    const userOrders = orders.filter(o => o.user_id === user.id);
    res.json(userOrders.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
  } catch (err: unknown) {
    console.error('Error fetching user orders:', err);
    res.status(500).json({ error: 'فشل في جلب قائمة الحجوزات الخاصة بك.' });
  }
});

/**
 * 12b. GET /api/orders/:order_id (Details for a local order)
 */
app.get('/api/orders/:order_id', (req, res) => {
  try {
    const { order_id } = req.params;
    const localOrder = orders.find(o => o.id === order_id);
    if (!localOrder) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }
    res.json(localOrder);
  } catch (err: unknown) {
    console.error('Error fetching order details:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل الحجز.' });
  }
});

/**
 * 13. GET /api/admin/orders (Returns all system orders)
 */
app.get('/api/admin/orders', (req, res) => {
  try {
    res.json(orders.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')));
  } catch (err: unknown) {
    console.error('Error fetching admin orders:', err);
    res.status(500).json({ error: 'فشل جلب طلبات النظام للإدارة.' });
  }
});

/**
 * 14. POST /api/orders/:order_id/receipt (Upload receipt for hold booking)
 */
app.post('/api/orders/:order_id/receipt', (req, res) => {
  try {
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
    order.payment_status = 'paid';
    order.admin_review_status = 'pending_approval'; // Awaiting admin ticket issuance

    if (order.user_id) {
      notifications.push({
        id: 'notif_' + Math.random().toString(36).substr(2, 9),
        user_id: order.user_id,
        title: 'إيصال الدفع قيد المراجعة ⏳',
        message: `تم رفع إيصال الدفع رقم ${receipt_number} لحجزك ${order.booking_reference}. يقوم موظفو خدمة العملاء بمراجعته وتأكيد الحجز قريباً.`,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, order });
  } catch (err: unknown) {
    console.error('Error uploading receipt:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء رفع إيصال السداد.' });
  }
});

/**
 * 15. POST /api/orders/:order_id/pay (Pay a hold booking using wallet balance)
 */
app.post('/api/orders/:order_id/pay', (req, res) => {
  try {
    const { order_id } = req.params;
    const order = orders.find(o => o.id === order_id);
    if (!order) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }

    const user = getActiveUser(req);
    const cost = order.office_total_amount || Number(order.total_amount);

    if (user.wallet_balance < cost) {
      res.status(400).json({ error: `رصيد المحفظة غير كافٍ لإتمام الدفع ($${user.wallet_balance.toFixed(2)} USD). القيمة المطلوبة هي $${cost.toFixed(2)} USD.` });
      return;
    }

    user.wallet_balance -= cost;
    order.payment_status = 'paid';
    order.admin_review_status = 'pending_approval'; // Awaiting admin ticket upload

    if (order.user_id) {
      notifications.push({
        id: 'notif_' + Math.random().toString(36).substr(2, 9),
        user_id: order.user_id,
        title: 'تم دفع قيمة الحجز المؤقت بنجاح 💰',
        message: `تم دفع $${cost.toFixed(2)} USD قيمة الحجز المؤقت رقم ${order.booking_reference} من محفظتك الإلكترونية بنجاح. جاري مراجعة وإصدار التذاكر قريباً.`,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, order });
  } catch (err: unknown) {
    console.error('Error paying hold booking:', err);
    res.status(500).json({ error: 'فشل إتمام عملية الدفع.' });
  }
});

/**
 * 16. GET /api/orders/:order_id/refresh (Refresh details - return local order)
 */
app.get('/api/orders/:order_id/refresh', (req, res) => {
  const { order_id } = req.params;
  const order = orders.find(o => o.id === order_id);
  if (!order) {
    res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
    return;
  }
  res.json(order);
});

/**
 * 17. POST /api/orders/:order_id/cancel (Cancel order and refund if paid)
 */
app.post('/api/orders/:order_id/cancel', (req, res) => {
  try {
    const { order_id } = req.params;
    const order = orders.find(o => o.id === order_id);
    if (!order) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }

    order.status = 'cancelled';
    order.admin_review_status = 'rejected';

    // Refund if paid via wallet
    if (!order.is_hold_booking && order.payment_status === 'paid' && order.user_id) {
      const user = users.find(u => u.id === order.user_id);
      if (user) {
        const cost = order.office_total_amount || Number(order.total_amount);
        user.wallet_balance += cost;
        notifications.push({
          id: 'notif_' + Math.random().toString(36).substr(2, 9),
          user_id: user.id,
          title: 'تم استرداد مبلغ الحجز لمحفظتك 💰',
          message: `تم إلغاء الحجز رقم ${order.booking_reference} بنجاح. تم إعادة المبلغ بالكامل $${cost.toFixed(2)} USD إلى محفظتك الإلكترونية.`,
          read: false,
          created_at: new Date().toISOString()
        });
      }
    } else if (order.user_id) {
      notifications.push({
        id: 'notif_' + Math.random().toString(36).substr(2, 9),
        user_id: order.user_id,
        title: 'تم إلغاء طلب حجزك ❌',
        message: `تم إلغاء الحجز المؤقت رقم ${order.booking_reference} بنجاح. لمزيد من الاستفسار يرجى التواصل مع خدمة العملاء.`,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, message: 'تم إلغاء الحجز بنجاح.', order });
  } catch (err: unknown) {
    console.error('Error cancelling order:', err);
    res.status(500).json({ error: 'فشل إلغاء الحجز.' });
  }
});

/**
 * 18. POST /api/admin/orders/:order_id/accept (Admin starts booking process)
 */
app.post('/api/admin/orders/:order_id/accept', (req, res) => {
  try {
    const { order_id } = req.params;
    const order = orders.find(o => o.id === order_id);
    if (!order) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }

    order.admin_review_status = 'booking_in_progress';

    if (order.user_id) {
      notifications.push({
        id: 'notif_' + Math.random().toString(36).substr(2, 9),
        user_id: order.user_id,
        title: 'حجزك قيد الإصدار الآن ✈️',
        message: `تمت الموافقة على طلب حجزك رقم ${order.booking_reference}. جاري الآن حجز المقاعد وإصدار التذاكر الإلكترونية يدوياً وسنقوم بإشعارك فور انتهائها.`,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, order });
  } catch (err: unknown) {
    console.error('Error accepting admin order:', err);
    res.status(500).json({ error: 'فشل قبول طلب الحجز.' });
  }
});

/**
 * 19. POST /api/admin/orders/:order_id/reject (Admin rejects order & refund if paid)
 */
app.post('/api/admin/orders/:order_id/reject', (req, res) => {
  try {
    const { order_id } = req.params;
    const order = orders.find(o => o.id === order_id);
    if (!order) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }

    order.status = 'cancelled';
    order.admin_review_status = 'rejected';

    // Refund if paid via wallet
    if (order.payment_status === 'paid' && order.user_id) {
      const user = users.find(u => u.id === order.user_id);
      if (user) {
        const cost = order.office_total_amount || Number(order.total_amount);
        user.wallet_balance += cost;
        notifications.push({
          id: 'notif_' + Math.random().toString(36).substr(2, 9),
          user_id: user.id,
          title: 'تم استرداد مبلغ الحجز لمحفظتك 💰',
          message: `تم رفض الحجز رقم ${order.booking_reference} من قبل الإدارة. تم إعادة المبلغ بالكامل $${cost.toFixed(2)} USD إلى محفظتك الإلكترونية.`,
          read: false,
          created_at: new Date().toISOString()
        });
      }
    } else if (order.user_id) {
      notifications.push({
        id: 'notif_' + Math.random().toString(36).substr(2, 9),
        user_id: order.user_id,
        title: 'تم رفض طلب حجزك ❌',
        message: `نأسف، تم رفض طلب حجزك رقم ${order.booking_reference}. لمزيد من التفاصيل يرجى التواصل مع خدمة العملاء.`,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, order });
  } catch (err: unknown) {
    console.error('Error rejecting admin order:', err);
    res.status(500).json({ error: 'فشل رفض الحجز.' });
  }
});

/**
 * 20. POST /api/admin/orders/:order_id/finalize (Admin inputs PNR and tickets)
 */
app.post('/api/admin/orders/:order_id/finalize', (req, res) => {
  try {
    const { order_id } = req.params;
    const { booking_reference, tickets } = req.body as { 
      booking_reference?: string; 
      tickets?: { passenger_name: string; ticket_number: string }[] 
    };

    const order = orders.find(o => o.id === order_id);
    if (!order) {
      res.status(404).json({ error: 'الحجز المطلوب غير موجود.' });
      return;
    }

    if (booking_reference) {
      order.booking_reference = booking_reference;
    }
    order.tickets = tickets || [];
    order.status = 'confirmed';
    order.payment_status = 'paid';
    order.admin_review_status = 'completed';

    if (order.user_id) {
      notifications.push({
        id: 'notif_' + Math.random().toString(36).substr(2, 9),
        user_id: order.user_id,
        title: 'تم تأكيد حجزك وإصدار التذاكر! 🎉✈️',
        message: `مبروك! تم إنهاء الحجز وإصدار التذاكر الإلكترونية بنجاح لحجزك رقم ${order.booking_reference}. يمكنك الآن فتح الحجز وتنزيل تذكرتك الإلكترونية (PDF).`,
        read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, order });
  } catch (err: unknown) {
    console.error('Error finalizing admin order:', err);
    res.status(500).json({ error: 'فشل تأكيد وإصدار تذاكر الحجز.' });
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

    if (!localOrder) {
      res.status(404).send('Booking details not found.');
      return;
    }

    const booking_reference = localOrder.booking_reference || 'HOLD';
    const officeTotalAmt = localOrder.office_total_amount ?? Number(localOrder.total_amount || 0);
    const currency = localOrder.total_currency || 'USD';
    const status = localOrder.status || 'awaiting_payment';

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
    doc.fillColor(slateGray).fontSize(9).text(`تاريخ الإصدار / Issued: ${new Date(localOrder.created_at || Date.now()).toLocaleDateString()}`, 300, 65, { align: 'right', width: 250 });

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
    const passengers = localOrder.passengers || [];
    
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
    doc.rect(40, itineraryY, 510, 45).fill(lightSlate).strokeColor(borderSlate).stroke();
    setFont(true);
    doc.fillColor(darkSlate).fontSize(10).text('مسار الرحلة / Route:', 55, itineraryY + 15);
    setFont(false);
    doc.fillColor(slateGray).fontSize(10).text(localOrder.route || 'CAI -> JED', 180, itineraryY + 15);
    setFont(true);
    doc.fillColor(darkSlate).fontSize(10).text('الناقل / Airline:', 350, itineraryY + 15);
    setFont(false);
    doc.fillColor(slateGray).fontSize(10).text(localOrder.owner_name || 'طيران شريك', 450, itineraryY + 15);
    itineraryY += 60;

    // Tickets Info section
    setFont(true);
    doc.fillColor(darkSlate).fontSize(12).text('تفاصيل التذكرة الإلكترونية / E-Ticket Details', 40, itineraryY + 10);
    doc.moveTo(40, itineraryY + 25).lineTo(550, itineraryY + 25).strokeColor(borderSlate).lineWidth(1).stroke();
    itineraryY += 35;

    let ticketsExist = false;
    setFont(false);
    if (localOrder.tickets && localOrder.tickets.length > 0) {
      localOrder.tickets.forEach((t: any) => {
        doc.fillColor(darkSlate).fontSize(10).text(`المسافر / Passenger: ${t.passenger_name}`, 50, itineraryY);
        setFont(true);
        doc.fillColor(emerald).fontSize(10).text(`رقم التذكرة / E-Ticket: ${t.ticket_number}`, 300, itineraryY);
        setFont(false);
        itineraryY += 20;
        ticketsExist = true;
      });
    }

    if (!ticketsExist) {
      doc.fillColor(slateGray).fontSize(9).text('سيتم إصدار أرقام التذاكر الإلكترونية فور مراجعة وتأكيد الحجز.', 50, itineraryY);
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
  try {
    const { office_markup_percentage } = req.body as { office_markup_percentage?: number };
    if (office_markup_percentage === undefined || isNaN(Number(office_markup_percentage)) || Number(office_markup_percentage) < 0) {
      res.status(400).json({ error: 'نسبة هامش الربح غير صالحة.' });
      return;
    }
    appSettings.office_markup_percentage = Number(office_markup_percentage);
    res.json({ success: true, settings: appSettings });
  } catch (err: unknown) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'فشل حفظ الإعدادات.' });
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
