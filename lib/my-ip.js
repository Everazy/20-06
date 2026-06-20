// v2
import express from 'express';

export default async function handler(req, res) {
  const response = await fetch('https://api.ipify.org?format=json');
  const data = await response.json();
  return res.status(200).json({ outbound_ip: data.ip });
}
