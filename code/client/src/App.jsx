import React from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Overview from "./pages/Overview.jsx";
import TransactionsWorkspace from "./pages/TransactionsWorkspace.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Reports from "./pages/Reports.jsx";
import Transactions from "./pages/Transactions.jsx";
import Categories from "./pages/Categories.jsx";
import Tags from "./pages/Tags.jsx";
import Rules from "./pages/Rules.jsx";
import Imports from "./pages/Imports.jsx";
import ImportDetails from "./pages/ImportDetails.jsx";
import Settings from "./pages/Settings.jsx";
import { Toaster } from "react-hot-toast";

export default function App() {
  return (
    <Layout>
      <Toaster position="top-center" />
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/transactions" element={<TransactionsWorkspace />} />
        <Route path="/management/old/dashboard" element={<Dashboard />} />
        <Route path="/management/old/reports" element={<Reports />} />
        <Route path="/management/old/transactions" element={<Transactions />} />
        <Route path="/management/old/categories" element={<Categories />} />
        <Route path="/management/old/tags" element={<Tags />} />
        <Route path="/management/old/rules" element={<Rules />} />
        <Route path="/management/old/imports" element={<Imports />} />
        <Route path="/management/old/imports/:id" element={<ImportDetails />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/imports" element={<Imports />} />
        <Route path="/imports/:id" element={<ImportDetails />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}
