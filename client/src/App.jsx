import React from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Transactions from "./pages/Transactions.jsx";
import Categories from "./pages/Categories.jsx";
import Rules from "./pages/Rules.jsx";
import Imports from "./pages/Imports.jsx";
import { Toaster } from "react-hot-toast";

export default function App() {
  return (
    <Layout>
      <Toaster position="top-center" />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/imports" element={<Imports />} />
      </Routes>
    </Layout>
  );
}
