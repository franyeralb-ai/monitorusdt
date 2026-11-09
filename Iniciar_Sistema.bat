@echo off
title Contaduria Clientes P2P - Binance Banesco
cd /d "%~dp0"
echo ========================================================
echo   Iniciando Sistema de Control P2P (Compras USDT Banesco)
echo   Abriendo navegador en http://localhost:3000 ...
echo ========================================================
start "" "http://localhost:3000"
node server.js
pause

