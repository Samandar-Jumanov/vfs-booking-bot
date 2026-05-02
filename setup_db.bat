@echo off
set PGPASSWORD=vfspass
"C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres -c "CREATE USER vfsuser WITH PASSWORD 'vfspass';"
"C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres -c "CREATE DATABASE vfsdb OWNER vfsuser;"
"C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres -l
echo DONE
