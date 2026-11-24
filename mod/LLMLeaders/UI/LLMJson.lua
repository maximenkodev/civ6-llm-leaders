-- ===========================================================================
-- LLMJson: минимальный JSON-сериализатор + hex-кодирование для передачи в мост.
-- Строки уходят как UTF-8 байты; весь пакет кодируется в hex, чтобы
-- канал FireTuner не мог испортить кириллицу.
-- ===========================================================================

LLMJson = {};

-- ВАЖНО: не использовать классы %c/%s/%a и т.п. — в игре они зависят от локали Windows
-- и считают байты 0x80-0x9F «управляющими», что ломает UTF-8 (кириллицу).
local function escapeString(s)
	s = string.gsub(s, '.', function(c)
		local b = string.byte(c);
		if b == 34 then return '\\"'; end
		if b == 92 then return '\\\\'; end
		if b == 10 then return '\\n'; end
		if b == 13 then return '\\r'; end
		if b == 9 then return '\\t'; end
		if b < 32 or b == 127 then return string.format("\\u%04x", b); end
		return c;
	end);
	return '"' .. s .. '"';
end

local function isArray(t)
	local n = 0;
	for k, _ in pairs(t) do
		if type(k) ~= "number" then return false; end
		n = n + 1;
	end
	for i = 1, n do
		if t[i] == nil then return false; end
	end
	return true, n;
end

function LLMJson.Encode(v)
	local tv = type(v);
	if tv == "nil" then return "null"; end
	if tv == "boolean" then return v and "true" or "false"; end
	if tv == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return "null"; end
		if math.floor(v) == v then return string.format("%d", v); end
		return string.format("%.4f", v);
	end
	if tv == "string" then return escapeString(v); end
	if tv == "table" then
		local arr, n = isArray(v);
		local parts = {};
		if arr and n > 0 then
			for i = 1, n do parts[i] = LLMJson.Encode(v[i]); end
			return "[" .. table.concat(parts, ",") .. "]";
		end
		if arr and n == 0 then return "[]"; end
		for k, val in pairs(v) do
			table.insert(parts, escapeString(tostring(k)) .. ":" .. LLMJson.Encode(val));
		end
		return "{" .. table.concat(parts, ",") .. "}";
	end
	return "null";
end

function LLMJson.ToHex(s)
	return (string.gsub(s, ".", function(c) return string.format("%02X", string.byte(c)); end));
end

-- Печатает пакет порциями: LLMQ|<seq>|<i>|<n>|<hex>
-- Мост собирает порции и декодирует.
local CHUNK = 1500;
local g_seq = 0;
function LLMJson.PrintPacket(tbl)
	g_seq = g_seq + 1;
	local hex = LLMJson.ToHex(LLMJson.Encode(tbl));
	local n = math.max(1, math.ceil(string.len(hex) / CHUNK));
	for i = 1, n do
		local part = string.sub(hex, (i - 1) * CHUNK + 1, i * CHUNK);
		print("LLMQ|" .. g_seq .. "|" .. i .. "|" .. n .. "|" .. part);
	end
end
