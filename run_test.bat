@echo off
cd C:\Users\Samer\Projects\AIOS
node --experimental-strip-types --no-warnings --test packages\persistence\test\executor-persistence.test.ts > persistence_out.txt 2>&1
echo.
echo === TEST OUTPUT ===
type persistence_out.txt
echo.
echo === EXIT CODE === %errorlevel%
del persistence_out.txt