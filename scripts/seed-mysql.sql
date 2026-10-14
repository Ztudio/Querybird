SET SESSION cte_max_recursion_depth=5000;
CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(200) UNIQUE, country CHAR(2), created_at DATETIME DEFAULT CURRENT_TIMESTAMP) COMMENT='People who buy things';
CREATE TABLE products (id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(20) UNIQUE NOT NULL, title VARCHAR(200), price DECIMAL(10,2), stock INT DEFAULT 0, active TINYINT(1) DEFAULT 1);
CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT, product_id INT, qty INT, total DECIMAL(10,2), status VARCHAR(20) DEFAULT 'pending', note TEXT, placed_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (customer_id) REFERENCES customers(id), FOREIGN KEY (product_id) REFERENCES products(id), INDEX idx_status (status));
INSERT INTO customers(name,email,country) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n<250) SELECT CONCAT('Customer ',n), CONCAT('c',n,'@example.com'), ELT(1+n%5,'US','IN','DE','GB','JP') FROM g;
INSERT INTO products(sku,title,price,stock,active) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n<60) SELECT CONCAT('SKU-',LPAD(n,4,'0')), CONCAT('Product ',n), ROUND(RAND()*200,2), FLOOR(RAND()*100), n%7<>0 FROM g;
INSERT INTO orders(customer_id,product_id,qty,total,status) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n<1200) SELECT 1+FLOOR(RAND()*249), 1+FLOOR(RAND()*59), 1+FLOOR(RAND()*4), ROUND(RAND()*500,2), ELT(1+n%4,'pending','paid','shipped','refunded') FROM g;
CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status='paid';
